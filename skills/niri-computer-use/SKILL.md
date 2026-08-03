---
name: niri-computer-use
description: >-
  Drives the visible desktop under the Niri Wayland compositor: opening or
  focusing applications, navigating graphical interfaces, clicking controls,
  entering text, arranging windows or workspaces, reading screen state, and
  verifying GUI results. Use for any task that requires interacting with the
  user's desktop (windows, workspaces, screens, mouse, keyboard) rather than
  the terminal. Requires niri, grim, ydotool (+ ydotoold), and jq.
---

# Niri Computer Use

Shell-native computer use on Niri/Wayland. Bash remains the primary composition
layer: use raw `niri msg` and `grim` directly. The bundled helper `niri-use`
exists only where raw shell is fragile or unsafe — guarded `ydotool` text and
key injection — plus small state/screenshot conveniences.

Helper is at `bin/niri-use` (see [README.md](README.md) for install).

## Busy border (do this before every desktop task)

Before doing **any** computer-use actions on the user's screen, show a red
border and keep it visible for the whole task. It tells the user "Pi is using
the computer — don't touch".

```bash
niri-use busy on      # red fullscreen outline (layer-shell-rs)
# ... do inspect / capture / act / verify ...
niri-use busy off      # clear it when the task is done or you stop
```

Rules:
- Always `busy on` **before the first desktop-affecting step** and `busy off`
  when you finish — whether the task succeeded, was stopped, or errored.
- `busy on` is the gate: if it fails (exit 1 / `BUSY_ON_FAILED`) stop and
  report — do not proceed with desktop actions while the indicator is missing.
- `busy off` is best-effort cleanup: an exit-0 result with `"ok":false` and a
  `warn` field means it could not clear the border — tell the user.
- `busy toggle` / `busy quit` are also available; prefer `on`/`off` for
  framing a task.
- The indicator communicates, it does not authorize recklessness: under the
  border you still follow every other safety rule.

- The indicator communicates, it does not authorize recklessness: under the
  border you still follow every other safety rule.

## Focus save/restore (give the user their window back)

Whenever a task changes which window (or workspace) is active — e.g. focusing
Discord, switching workspaces — the user's original window must be restored
when the task ends. Pi runs in a terminal window; leaving the user staring at
a different app is a failure.

```bash
niri-use state --save                 # snapshot current focus (default path)
niri msg action focus-window --id 8   # ... do the computer-use actions ...
niri-use restore                      # refocus the original window
```

- `state --save [PATH]` records the focused window id/app/title/workspace.
- `restore [--from PATH]` re-focuses the saved window and **verifies** it took
  effect (`verification.focus_restored`).
- If the saved window is gone (user closed it), restore degrades to
  re-focusing its saved workspace; if that is gone too it fails with
  `RESTORE_TARGET_GONE` — report it, never guess a substitute.
- Restore first, *then* `busy off` — the border should stay up until the
  desktop is back to its original state.
- Same default snapshot path (`$XDG_RUNTIME_DIR/pi-niri-computer-use/focus.json`)
  for both; use explicit `--save/--from` paths for parallel tasks.

## Workflow: inspect → capture → choose action → act → verify

Never skip to acting. Every meaningful action follows this loop.

### 1. Inspect

Query the smallest useful state, as JSON, and summarize:

```bash
niri msg -j focused-window   # single object; fields: id, app_id, title, workspace_id
niri msg -j windows          # array; focused window has "is_focused": true
niri msg -j workspaces       # array; id, idx, output, is_active, is_focused
niri msg -j outputs          # object keyed by output name; .logical = {x,y,width,height}
```

Notes:
- `niri msg -j focused-window` prints one JSON object (not an array). When
  nothing is focused it prints an empty line — treat as "no focused window".
- Window IDs come from `id`. App IDs from `app_id`. Use `jq` when you need to
  filter (e.g. `niri msg -j windows | jq 'map(select(.app_id=="firefox"))'`).
- Windows do **not** expose absolute screen coordinates in Niri 26.04, so never
  derive click targets from window layout fields. Use output geometry +
  screenshots instead.
- Re-check state right before any action that depends on it; do not trust a
  query made minutes ago.
- **Find the target by title too, not only `app_id`.** An app is often a
  browser tab or web UI: its window has a browser `app_id` (e.g. `firefox`)
  and the site name in the title. Search `title` (case-insensitive) as well;
  "already open" means it exists in *any* form, including a tab.
- When a target exists as a browser tab, work with that window — do not
  launch the native app alongside it.

### 2. Capture

```bash
niri-use screenshot                                  # all outputs, writes PNG
niri-use screenshot --output HDMI-A-2                # one named output
niri-use screenshot --region 0,0,1920,1080           # explicit logical-pixel region
niri-use screenshot --file /tmp/proof.png            # deliberate filename
```

Screenshots go to `${XDG_RUNTIME_DIR:-/tmp}/pi-niri-computer-use/` unless
`--file` is given. The command prints the path (also as JSON with `--json`).
Inspect the PNG by reading the returned path — Pi's read tool renders it.

Take the screenshot, then `read` the path. Never click from a screenshot whose
layout may have changed.

### 3. Choose action (in order of preference)

1. **Semantic Niri action**: `niri msg action ...` (focus-window --id, focus-workspace, move-window-to-workspace, maximize-column, set-window-width, ...). Full list: `niri msg action --help`.
2. **Keyboard shortcut / key sequence**: `niri-use key ...` (guarded ydotool).
3. **Literal text**: `niri-use type --text '...'`.
4. **Pointer coordinates**: `niri-use move/click` — only when no semantic route exists, using fresh output geometry and a recent screenshot.

### 4. Act

- Raw Niri action: `niri msg action focus-window --id 42` (argv, no shell needed).
- Guarded input via `niri-use` — it re-checks the focused window immediately
  before injecting and refuses on mismatch:

```bash
niri-use type --text 'hello' \
  --expect-window-id 42 \
  --expect-app-id org.example.App
```

- `--dry-run` prints the plan and executes nothing.
- `--json` gives machine-readable results.
- Key codes are Linux input-event-codes; see [references/COMMANDS.md](references/COMMANDS.md) for the common table and chord syntax.

### 5. Verify

After any action that changes UI: re-query Niri state and/or capture a fresh
screenshot. Never report success because the command exited 0.

- after focusing a window → `niri msg -j focused-window`, check `id`
- after moving a workspace → `niri msg -j workspaces`, check `is_active`
- after typing → screenshot (unless the app exposes a safer state check)
- after a click → screenshot

Retry only after observing *why* the action failed; never blindly repeat clicks
or key presses.

## Safety rules (hard)

- **Stop when the target is ambiguous** or a focus assertion fails. Report the
  mismatch; do not guess.
- **Never guess stale coordinates.** Re-capture before any pointer action.
- **Never type secrets** unless the user explicitly supplied them for that
  exact action.
- **Never submit, purchase, delete, send, or confirm a destructive action**
  without clear user intent stated for this action.
- **Never spawn/launch an application for a read-only task** (check state,
  unread messages, read content). Bring up and focus what already exists;
  verify by screenshot. Launching changes the user's desktop and is never
  required to observe something.
- **Never spawn unless the target is verified absent** — matched by `app_id`
  *and* `title` (including as a browser tab) — and only when the task
  genuinely needs a new window. Prefer focusing the existing tab or window.
  After spawning, verify the new window appeared before proceeding.
- Prefer semantic Niri actions over pixels.
- Minimize screenshots and state dumps, but keep enough evidence to verify.
- `niri-use` never starts `ydotoold`; if the daemon is down, it surfaces the
  ydotool error — report it and stop, don't retry in a loop.
- `niri-use` redacts typed text from all output by default (`--unsafe-debug`
  + `--verbose` disables redaction for debugging only).

## Examples

**1. Focus window by app ID**

```bash
WID=$(niri msg -j windows | jq -r '.[] | select(.app_id=="firefox") | .id' | head -1)
niri msg action focus-window --id "$WID"
niri msg -j focused-window | jq -r '.app_id'   # verify: must print firefox
```

**2. Capture screenshot and inspect it**

```bash
niri-use screenshot --output HDMI-A-2 --file /tmp/ui.png
# read /tmp/ui.png with the read tool to see the screen
```

**3. Type into expected focused window**

```bash
niri-use type --text 'git commit -m "wip"' \
  --expect-app-id kitty --json
```

Focus is re-asserted right before injection; a mismatch aborts with a
`FOCUS_MISMATCH` error and nothing is typed.

**4. Click coordinate then verify screenshot**

```bash
# after a fresh screenshot shows the button at logical (x,y) on HDMI-A-2
niri-use click --x 640 --y 400 --button left --expect-window-id "$WID"
niri-use screenshot --file /tmp/after.png   # then read it and check the UI changed
```

**5. Recover from focus mismatch**

```bash
niri-use type --text 'hello' --expect-window-id 42   # FOCUS_MISMATCH: focused window changed
niri msg -j focused-window                            # find out what actually has focus
# then either re-focus the intended window, or re-target the action at the real window
niri msg action focus-window --id 42
niri-use type --text 'hello' --expect-window-id 42
```

**6. Arrange windows using Niri actions (no pointer)**

```bash
niri msg action move-window-to-workspace 2 --window-id 42
niri msg action focus-workspace 2
niri msg action maximize-column
niri msg action focus-window --id 7
niri msg -j workspaces | jq 'map({id, is_active, active_window_id})'   # verify
```

## Reference

- [references/COMMANDS.md](references/COMMANDS.md) — `niri-use` reference, keycode table, useful `niri msg action` list.
- [README.md](README.md) — install, prerequisites, permissions, debugging.
