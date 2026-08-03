# niri-computer-use

Shell-native computer-use workflow for the Niri Wayland compositor:
**`niri msg` + `grim` + guarded `ydotool`**, with a small `niri-use` shim only
for operations where raw shell is fragile or unsafe (literal text injection,
key chords, pointer input, focus assertions).

- No MCP server. No generic desktop automation framework.
- Bash + `niri msg` + `grim` stay the primary composition layer.
- `niri-use` adds: pre-injection focus assertions, argv-safe text/key/pointer
  injection, redaction, dry-run, structured errors, screenshots.

## Install

This directory is itself the skill. Link or copy it into a Pi skill location:

```bash
ln -s "$PWD" ~/.pi/agent/skills/niri-computer-use
# or: cp -r "$PWD" ~/.pi/agent/skills/niri-computer-use
```

Expose the helper on PATH (optional but convenient):

```bash
ln -s "$PWD/bin/niri-use" ~/.local/bin/niri-use
```

No build step, no dependencies, no `npm install`. Requires Node.js ≥ 23.6
(TypeScript type-stripping; tested on Node 26).

## Prerequisites

| tool | purpose | check |
|---|---|---|
| `niri` | compositor, state queries, semantic actions | `niri msg version` |
| `grim` | screenshots | `grim -h` |
| `ydotool` + `ydotoold` | keyboard/mouse injection | `ydotool --help` |
| `layer-shell-rs` | busy-border indicator (`niri-use busy on/off`) | `layer-shell-rs outline --help` |
| `jq` | JSON filtering in the skill workflow | `jq --version` |

`ydotoold` must be running before any `niri-use type/key/click/move`:

```bash
ydotoold &   # systemd user service is the cleaner option
```

`niri-use` never starts or reconfigures `ydotoold` — if the socket is missing
you get ydotool's own error; do not retry in a loop.

## Permissions

- `niri msg` requires the `NIRI_SOCKET` env var or the session-scoped socket
  (`$XDG_RUNTIME_DIR/niri.wayland-*.sock`) — a normal desktop session has this.
- `grim` needs `WAYLAND_DISPLAY` — normal in a session.
- `ydotool` needs the `YDOTOOL_SOCKET` (default `$XDG_RUNTIME_DIR/.ydotool_socket`)
  and the `ydotoold` daemon running with uinput access (user `input` group or
  udev rule; see ydotool docs).
- If you run Pi over SSH, forward these env vars (`NIRI_SOCKET`,
  `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `YDOTOOL_SOCKET`); otherwise the tools
  cannot reach the compositor/daemon.

## Usage

```bash
niri msg -j focused-window            # inspect (raw)
niri msg action focus-window --id 42  # semantic action (raw)
niri-use screenshot --output HDMI-A-2 # capture; read the printed path to inspect
niri-use type --text 'hello' \
  --expect-app-id kitty               # guarded injection with focus assertion
niri-use click --x 640 --y 400        # pointer, only when no semantic route
niri-use busy on                      # red border before Pi touches the desktop
niri-use busy off                     # clear it when done
```

## Busy border

Frame computer-use tasks with the busy indicator: `niri-use busy on` before
the first screen-affecting step and `niri-use busy off` when done, stopped, or
errored. It draws a red fullscreen outline (`layer-shell-rs outline`) so you can
see at a glance that Pi is operating the machine and shouldn't be interrupted.

- `busy on` is a safety gate — a failure exits with `BUSY_ON_FAILED` and the
  assistant should not proceed with desktop actions.
- `busy off` is best-effort clean up — a stuck border surfaces as `"ok":false`
  with a `warn` rather than failing the task.
- `busy toggle` flips visibility; `busy quit` removes the instance.

- `busy toggle` flips visibility; `busy quit` removes the instance.

## Focus save / restore

Before a task that switches the active window or workspace, snapshot the user's
state; when done, hand it back so the terminal Pi runs in is re-focused.

```bash
niri-use state --save          # remember current focus
niri msg action focus-window --id 8   # task actions…
niri-use restore                # refocus the original window
```

`restore` verifies the focus took effect, falls back to the saved workspace if
the window closed, and errors with `RESTORE_TARGET_GONE` if nothing remains.

Full reference: [references/COMMANDS.md](references/COMMANDS.md).

## Testing

```bash
npm test          # unit + integration tests against fake-bin/ (no display needed)
npm run check     # syntax-check every TS file via node --check
npm run live-smoke  # conservative checks against a real Niri session (safe only)
```

- `tests/unit.test.ts` — argv fidelity (spaces/quotes/multiline/unicode/leading
  dash), focus assertion pass/mismatch, length limits, invalid coords/buttons,
  timeout, failure propagation, JSON shapes, redaction.
- `tests/integration.test.ts` — fake `niri`/`grim`/`ydotool` on `PATH` record
  exact argv; asserts no shell interpolation, screenshot paths, and that input
  is blocked on focus mismatch.
- `fake-bin/` — tiny recorders; `FAKE_LOG` collects `{tool, argv}` JSON lines,
  `FAKE_FOCUSED_ID`/`FAKE_FOCUSED_APP` control the fake focused window,
  `FAKE_*_EXIT`/`FAKE_*_SLEEP_MS` simulate failures/timeouts.

## Debugging

- **`FOCUS_MISMATCH`** — the focused window changed between planning and
  injection (or you asserted the wrong id). Re-run `niri msg -j focused-window`,
  then either `niri msg action focus-window --id N` first or re-target.
- **`TIMEOUT`** — a child process hung; raise with `--timeout-ms`. Usually
  `ydotoold` being down or a blocked compositor.
- **`YDO_FAILED`** — ydotool itself errored (daemon down, bad keycode). Check
  `ydotoold` and the keycode table.
- **`BAD_COORDINATES`** — coordinates outside all outputs' logical bounds.
  Re-check `niri msg -j outputs`.
- **`SCREENSHOT_FAILED`/`SCREENSHOT_MISSING`** — grim failed or wrote no file;
  check `WAYLAND_DISPLAY` and the output name.
  check `WAYLAND_DISPLAY` and the output name.
- **`RESTORE_TARGET_GONE`** — the saved window and its workspace both
  disappeared; re-check `niri msg -j windows` / `workspaces`.
- **`SNAPSHOT_MISSING`/`SNAPSHOT_BAD`** — `restore` couldn't read the focus
  snapshot; re-run `state --save`.
- Text never appears in output unless `--verbose --unsafe-debug`.

## Limitations

- Niri 26.04 does not expose absolute on-screen coordinates for windows, so
  "focused-window region" capture is intentionally unsupported; use output or
  region capture.
- `key` uses numeric Linux keycodes (explicit `code:state` tokens), not key
  names — see the reference table.
- This skill targets Niri only. No GNOME/KDE/Hyprland/X11/macOS/Windows support
  by design.
