# Autopilot — Event IPC & 1:1 Handoff Architecture

> Status: **specification**. Module layout: `index.ts`, `ipc.ts`, `tools.ts`, `ui.ts`.

## 1. Overview

`/autopilot` splits a single Pi session across two cooperating processes inside
one tmux window:

| Role | Env | Process | Tool surface |
|------|-----|---------|-------------|
| **Primary** | (default) | The Pi instance the user types into. | Full built-in toolset. |
| **Pilot** | `PI_AUTOPILOT=1` | A sidecar Pi spawned in a `tmux split-window`. | Restricted to `tmux_read_pane`, `tmux_send_chars`, `tmux_start_turn`. |

The Pilot observes the Primary's tmux pane and drives it by sending keystrokes.
The two processes are synchronized over a **UNIX domain socket** so the Pilot
can tell, with certainty, when a keystroke it sent actually started a Primary
turn and when that turn finished.

This replaces the legacy design (alternating turns via `ctx.abort()` hacks and
`tmux paste-buffer`), which was racy and could not distinguish "the Primary is
still thinking" from "the Primary is idle and waiting for input."

## 2. Process topology

```
                 ┌──────────────── tmux window ────────────────┐
                 │                                              │
                 │   PRIMARY (user pane)        PILOT (sidecar) │
                 │   full toolset               3 tmux tools    │
                 │        │                          │          │
                 │        │ binds                    │ connects │
                 │        ▼                          ▼          │
                 │   /tmp/pi-autopilot-<pane>.sock (AF_UNIX)    │
                 │   line-delimited JSON event stream ──────────┼──► Pilot
                 │   (Primary is server, Pilot is client)       │
                 └──────────────────────────────────────────────┘
```

- The **Primary** is the IPC **server**. It `bind()`s the socket at startup and
  `listen()`s for a single Pilot connection.
- The **Pilot** is the IPC **client**. It `connect()`s to the socket path given
  in `PI_AUTOPILOT_SOCK` and reads a stream of newline-delimited JSON events.
- The socket path is `/tmp/pi-autopilot-<primary_pane_id>.sock`, where
  `<primary_pane_id>` is the tmux pane id (`%N`) captured via
  `tmux display-message -p '#{pane_id}'` in the Primary at `/autopilot` time.

### 2.1 Spawning the sidecar

`/autopilot` (run in the Primary) performs:

1. Capture the Primary pane id: `tmux display-message -p '#{pane_id}'`.
2. Compute `SOCK = /tmp/pi-autopilot-<pane_id>.sock`. `unlinkSync(SOCK)` first
   (defensive; see §6 lifecycle).
3. Start the IPC server (Primary side) bound to `SOCK`.
4. `tmux split-window -h -p 45` a new shell exporting:
   - `PI_AUTOPILOT=1`
   - `PI_AUTOPILOT_MAIN_PANE=<pane_id>`
   - `PI_AUTOPILOT_SOCK=<SOCK>`
   - `PI_AUTOPILOT_GOAL=<goal>` (optional, from `/autopilot <goal>`)
5. In that shell, launch `pi` (the Pilot). The Pilot extension detects
   `PI_AUTOPILOT=1`, connects to `PI_AUTOPILOT_SOCK`, restricts its tool
   surface, and (if `PI_AUTOPILOT_GOAL` is set) seeds its first turn.

## 3. IPC wire protocol

One line per event, UTF-8, `\n`-terminated JSON.

```jsonc
// Primary → Pilot (broadcast)
{ "type": "agent_start",    "seq": 7, "ts": 1700000000000 }
{ "type": "agent_settled",  "seq": 8, "ts": 1700000004500 }

// Pilot → Primary (request)
{ "type": "start_turn_ok",  "ts": 1700000000100 }
```

### 3.1 Event types

| `type` | Direction | Meaning |
|--------|-----------|---------|
| `agent_start`   | P→Pilot | A Primary agent loop has begun. Emitted on the `agent_start` lifecycle hook. |
| `agent_settled` | P→Pilot | The Primary agent loop has fully settled (no retry/compaction/continuation pending). Emitted on `agent_settled`. |
| `start_turn_ok` | Pilot→P | The Pilot is intentionally starting a turn and asks the Primary to lift the turn gate (see §5). |

### 3.2 Monotonic sequence numbers

`seq` is a **Primary-side monotonic counter** incremented on **every** emitted
`agent_start` and `agent_settled` event. It is the only safe way for the Pilot
to correlate "the turn I just started" with "the events the Primary produced
because of it."

- `agent_start` and the matching `agent_settled` for the same loop share a
  relationship: `settled.seq > start.seq`, and no other `agent_start` appears
  between them under normal 1:1 operation.
- The Pilot never assigns `seq`; it only reads and compares.

## 4. The three Pilot tools

The Pilot's entire tool surface is exactly these three tools, enforced via
`ctx.setActiveTools(["tmux_read_pane","tmux_send_chars","tmux_start_turn"])`
on Pilot startup.

### 4.1 `tmux_read_pane` — non-blocking observation

- **Params:** none.
- **Behavior:** `tmux capture-pane -p -t <main_pane> -S -<scrollback>` and
  return the text. Never blocks, never touches IPC.
- **Returns:** `{ content: [TextContent] }` with the pane buffer.
- **Use:** the Pilot reads the Primary's screen to decide what to do next.

### 4.2 `tmux_send_chars` — non-blocking keystrokes (cannot start turns)

- **Params:** `keys: string[]` (tmux key arguments, e.g. `["C-u"]`,
  `["Shift-Tab"]`, `["Up"]`).
- **Behavior:** sends the keys via `tmux send-keys -t <main_pane> <keys...>`.
  **Does not wait for any IPC event.** Returns immediately.
- **Turn prevention (the gate, §5):** Because these keys are delivered to the
  Primary's *input box*, a key like `Enter` would normally submit a turn. In
  autopilot mode the Primary runs a **turn gate** that blocks
  UI-submitted turns unless the Pilot has first sent `start_turn_ok`. So if the
  model mistakenly uses `tmux_send_chars` with `Enter`, the Primary refuses the
  turn, prints an **error into its own pane** (e.g.
  `autopilot: turn blocked — use tmux_start_turn`), and the tool returns
  instantly. The Pilot can then `tmux_read_pane` and see the error in the
  buffer, correcting itself.
- **Returns:** `{ content: [TextContent("sent: <keys joined>")] }`.
- **Use:** editing the input box, clearing it (`C-u`), cycling history
  (`Up`/`Down`), changing thinking level (`Shift-Tab`), moving the cursor —
  anything that is *not* submitting a turn.

### 4.3 `tmux_start_turn` — blocking, always starts a turn

- **Params:** `keys: string[]` — the keystrokes that submit the turn. Typically
  `["Enter"]`, but may be a draft-then-submit sequence.
- **Behavior:**
  1. Send `start_turn_ok` to the Primary over IPC. This lifts the gate for the
     next UI-submitted turn only (one-shot token, §5.2).
  2. Capture `beforeSeq` = highest `seq` the Pilot client has observed so far.
  3. `tmux send-keys -t <main_pane> <keys...>` (dispatch the submitting keys).
  4. **Phase 1 — wait for `agent_start`** with `seq > beforeSeq`, 30s timeout.
     - On success: record `startSeq`.
     - On timeout: the keys did **not** start a turn. Return an **error** to the
       model containing the new pane content (captured via `tmux_read_pane`),
       so the model can see what actually happened. Do not throw — return an
       `isError`-style result so the loop continues.
  5. **Phase 2 — wait for `agent_settled`** with `seq > startSeq`, 10min
     timeout.
     - On success: return the new pane content (the Primary's finished output).
     - On timeout: return an error with the current pane content.
- **Returns on success:** `{ content: [TextContent(<new pane buffer>)] }`.
- **Returns on Phase-1/Phase-2 timeout:** an error result whose `content`
  includes both a diagnostic line and the current pane buffer.
- **Use:** the *only* way the Pilot submits a Primary turn.

> **Why split send vs start_turn:** the previous design made every
> `tmux_send_chars` block up to 30s waiting for `agent_start`, so a
> sub-second keystroke like `Shift-Tab` (change thinking level) took 30s.
> Splitting "send keys" (instant, gate-protected) from "start a turn"
> (blocking, gate-lifting) makes non-turn keystrokes return immediately while
> still making it impossible to accidentally start a turn with the fast tool.

## 5. The turn gate (Primary side)

The gate's job: **in autopilot mode, a turn submitted through the Pi UI (the
user — or the Pilot's keystrokes — pressing Enter in the input box) must be
blocked unless the Pilot has explicitly authorized it with `start_turn_ok`.**

### 5.1 What gets blocked, and what does not

The gate hooks the **`input`** event, whose payload carries
`source: "interactive" | "rpc" | "extension"`.

- **Blocked:** `source === "interactive"` turns, *unless* a `start_turn_ok`
  token is currently valid (§5.2). This is the path the Pilot's
  `tmux send-keys Enter` takes — it lands in the input box and is submitted as
  an interactive turn.
- **Never blocked:** `source === "extension"` (e.g. a compaction-resume
  continuation injected by a plugin) and `source === "rpc"`. Programmatic turns
  bypass the gate entirely. This is critical: automatic compaction resuming and
  firing a continue turn must not be blocked.

### 5.2 The `start_turn_ok` token

- The Pilot sends `{ "type": "start_turn_ok" }` immediately before dispatching
  the submitting keys in `tmux_start_turn`.
- The Primary receives it and sets a **one-shot, short-TTL token**
  (`turnAllowed = true`, auto-expires after ~5s). The next
  `source === "interactive"` `input` event consumes the token and is allowed
  through; any later interactive input without a fresh token is blocked.
- One-shot means a single `start_turn_ok` authorizes exactly one turn. The
  Pilot must send a new `start_turn_ok` for each `tmux_start_turn` call.

### 5.3 Blocking behavior

When the gate blocks an interactive turn:

- The `input` handler returns `{ action: "handled" }`, which **swallows** the
  input — no turn starts.
- The Primary prints a visible error line into its own pane:
  `autopilot: turn blocked — use tmux_start_turn to start a turn`.
  Because this text is in the pane, the Pilot's next `tmux_read_pane` will see
  it and can self-correct.
- The Primary also emits a short `ctx.ui.notify(...)` so the human user notices.

### 5.4 Gate is Primary-only

The gate is installed only in the Primary process (the one *without*
`PI_AUTOPILOT=1`). The Pilot process has no input box the user types into, so
no gate is needed there.

## 6. Lifecycle & socket cleanup

| Event | Action |
|-------|--------|
| `/autopilot` invoked (Primary) | Compute `SOCK`, `unlinkSync(SOCK)` (ignore ENOENT), start server, spawn sidecar. |
| Primary `session_shutdown` | `server.close()`, `unlinkSync(SOCK)`, clear status. |
| Pilot `session_shutdown` | `client.close()`, clear status. |
| Primary process crash | Best-effort: the socket file may linger; the *next* `/autopilot` `unlinkSync`s it before `bind()`. `EADDRINUSE` is therefore never fatal. |

`unlinkSync` before `bind()` is the primary defense against `EADDRINUSE`; the
`session_shutdown` unlink is the clean-path defense.

## 7. UI integration

- **Primary:** on `/autopilot`, `ctx.ui.setStatus("autopilot", "autopilot on")`.
  On `session_shutdown`, `ctx.ui.setStatus("autopilot", undefined)`.
- **Pilot:** on startup, `ctx.ui.setStatus("autopilot", "autopilot pilot")`.
  On `session_shutdown`, clear it.
- The status key `autopilot` appears in the footer status bar via the default
  footer's `setStatus()` integration.

## 8. Module responsibilities

| File | Owns |
|------|------|
| `ipc.ts` | `AutopilotServer` (Primary: bind/listen/broadcast, `seq` counter, `start_turn_ok` token store) and `AutopilotClient` (Pilot: connect, line-buffered JSON parse, `waitForEvent(type, predicate, timeout)`, `send(obj)`). |
| `tools.ts` | The three `ToolDefinition`s. `tmux_read_pane` and `tmux_send_chars` are thin; `tmux_start_turn` orchestrates `send(start_turn_ok)` → capture `beforeSeq` → send-keys → Phase 1 → Phase 2. All tmux I/O via `ctx.exec("tmux", [...])`. |
| `ui.ts` | `setStatus` helpers (`autopilotOn`, `autopilotPilot`, `autopilotOff`). |
| `index.ts` | Mode detection (`PI_AUTOPILOT=1` → Pilot, else Primary). Registers `/autopilot` command (Primary). Wires lifecycle hooks: Primary `agent_start`/`agent_settled` → `server.broadcast`; Primary `input` → gate; Pilot `before_agent_start`/startup → `setActiveTools` + client connect + optional goal seed. |

## 9. Sequence-correlation state machine (Pilot, `tmux_start_turn`)

```
send start_turn_ok
beforeSeq = client.lastSeq
tmux send-keys <keys>
        │
        ▼
┌───────────────────────────────────┐
│ Phase 1: wait agent_start         │
│   predicate: seq > beforeSeq      │
│   timeout: 30s                    │
└───────────────┬───────────────────┘
        timeout │         ok
        ┌───────┴───────┐
        ▼               ▼
  return error     startSeq = event.seq
  + pane content           │
                          ▼
          ┌───────────────────────────────────┐
          │ Phase 2: wait agent_settled       │
          │   predicate: seq > startSeq       │
          │   timeout: 10min                  │
          └───────────────┬───────────────────┘
                  timeout │         ok
                  ┌───────┴───────┐
                  ▼               ▼
            return error     return success
            + pane content   + pane content
```

## 10. Environment variables

| Var | Set in | Read by | Purpose |
|-----|--------|---------|---------|
| `PI_AUTOPILOT` | sidecar spawn | `index.ts` | `1` → Pilot mode. |
| `PI_AUTOPILOT_MAIN_PANE` | sidecar spawn | `tools.ts` | tmux target pane for the Primary. |
| `PI_AUTOPILOT_SOCK` | sidecar spawn | `ipc.ts` (client) | Socket path to connect to. |
| `PI_AUTOPILOT_GOAL` | sidecar spawn (optional) | `index.ts` (Pilot) | Initial goal text for the Pilot's first turn. |

## 11. Failure modes & guarantees

- **Pilot sends `Enter` via `tmux_send_chars`:** gate blocks it, Primary pane
  shows an error, tool returns instantly. No 30s wait. ✓
- **Pilot sends `Shift-Tab` via `tmux_send_chars`:** no turn attempted, gate
  irrelevant, tool returns instantly. ✓
- **Pilot calls `tmux_start_turn` with non-submitting keys:** Phase 1 times out
  at 30s, returns error + pane content. Model self-corrects. ✓
- **Pilot calls `tmux_start_turn` correctly:** gate lifted, turn runs, Phase 2
  returns the finished pane content. ✓
- **Compaction resume fires a continue turn:** `source === "extension"`, gate
  does not block. ✓
- **Primary crashes:** socket file lingers; next `/autopilot` `unlinkSync`s it
  before `bind()`. No `EADDRINUSE`. ✓
- **Pilot disconnects mid-turn:** Primary server tolerates client drop; next
  `/autopilot` re-establishes. In-flight `tmux_start_turn` Phase 1/2 waits
  reject on socket close. ✓