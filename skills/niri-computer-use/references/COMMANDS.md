# niri-use command reference

`niri-use` is a narrow guarded input shim. It does **not** wrap every Niri
subcommand — use raw `niri msg` and `grim` directly.

## Operations

```
niri-use state [--json]
niri-use screenshot [--output NAME] [--region X,Y,W,H] [--file PATH] [--json]
niri-use type --text TEXT [--expect-window-id N] [--expect-app-id APP]
              [--max-length N] [--dry-run] [--json] [--verbose]
niri-use key KEY... [--expect-window-id N] [--expect-app-id APP]
            [--allow-dangerous] [--dry-run] [--json]
niri-use move --x N --y N [--dry-run] [--json]
niri-use click --x N --y N [--button left|right|middle|side|extra|forward|0xNN]
              [--expect-window-id N] [--expect-app-id APP] [--dry-run] [--json]
niri-use busy on|off|toggle|quit [--color COLOR] [--thickness N] [--dry-run] [--json]

```

Common flags:

| flag | meaning |
|---|---|
| `--json` | machine-readable result on stdout |
| `--dry-run` | plan only, execute nothing |
| `--timeout-ms N` | subprocess timeout (default 15000) |
| `--verbose` | extra stderr logging; typed text shown as `<redacted>` |
| `--unsafe-debug` | with `--verbose`, print typed text (dev only) |

Env overrides: `NIRI_BIN`, `GRIM_BIN`, `YDOTOOL_BIN`, `LAYER_SHELL_RS_BIN`.
`YDOTOOL_SOCKET` is passed through to ydotool.

## Busy border (layer-shell-rs)

`busy` draws and clears a red fullscreen outline so the user can tell when Pi
is operating the desktop. Wrap a computer-use task with `busy on` … `busy off`.

- `busy on` — show the outline (default color `#ff0000`, thickness 4; override
  with `--color` / `--thickness`). **Safety gate**: if it fails the command
  exits 1 with `BUSY_ON_FAILED` and you should not proceed.
- `busy off` — hide it. Best-effort: a failed hide reports `"ok":false` with a
  `warn` rather than erroring, so a stuck border is communicated, not silent.
- `busy toggle` — toggle visibility.
- `busy quit` — terminate the outline instance.

Requirements: `layer-shell-rs` on PATH (bin override: `LAYER_SHELL_RS_BIN`).

## Focus assertion

`--expect-window-id N` / `--expect-app-id APP` re-query
`niri msg -j focused-window` immediately before injection. On mismatch the
command exits 1 with a structured error:

```json
{
  "ok": false,
  "operation": "type",
  "error": { "code": "FOCUS_MISMATCH", "message": "focused window does not match expected target" },
  "expected": { "window_id": 42 },
  "actual": { "window_id": 57, "app_id": "org.other.App" }
}
```

Success:

```json
{
  "ok": true,
  "operation": "type",
  "target": { "window_id": 42, "app_id": "org.example.App" },
  "verification": { "focus_assertion_passed": true }
}
```

Typed text is never included in JSON output.

## Focus save / restore

Give the user their window back after a task that switched the active window or
workspace.

```
niri-use state --save [PATH]   # snapshot current focus
niri-use restore [--from PATH]  # refocus it (default same path)
```

```bash
niri-use state --save
niri msg action focus-window --id 8
# ... actions ...
niri-use restore
```

Snapshot file (default `${XDG_RUNTIME_DIR:-/tmp}/pi-niri-computer-use/focus.json`):

```json
{ "window_id": 6, "app_id": "firefox", "title": "…", "workspace_id": 2 }
```

`restore` re-focuses the saved window and verifies via `focused-window`. If that
window no longer exists it falls back to the saved workspace; if neither exists
it exits 1 with `RESTORE_TARGET_GONE`. Use it before `busy off` so the border
covers the whole task.

## Key tokens

`key` takes Linux input-event-codes with optional state:

- `<KEYCODE>` — tap (pressed then released)
- `<KEYCODE>:<state>` — explicit down (`:1`) / up (`:0`)

Chord example (ctrl+shift+a):

```
niri-use key 29:1 42:1 30:1 30:0 42:0 29:0
```

### Common keycodes

| key | code | key | code |
|---|---|---|---|
| A | 30 | Z | 44 |
| Enter | 28 | Escape | 1 |
| Backspace | 14 | Tab | 15 |
| Delete | 111 | Space | 57 |
| Left Shift | 42 | Right Shift | 54 |
| Left Ctrl | 29 | Right Ctrl | 97 |
| Left Alt | 56 | Right Alt | 100 |
| Super (Meta) | 125 | Left / Right / Up / Down | 105 / 106 / 103 / 108 |
| Home / End | 102 / 107 | PageUp / PageDown | 104 / 109 |
| F1..F12 | 59,60,61,62,63,64,65,66,67,68,87,88 |

Full table: `/usr/include/linux/input-event-codes.h` (`KEY_*` values).

Dangerous keycodes (POWER/SLEEP/WAKEUP family) are refused unless
`--allow-dangerous` is passed.

## Coordinates

`move` and `click` take **absolute logical pixel coordinates** in the combined
output space (same space as `niri msg -j outputs` → `.logical`). Coordinates
outside the union of output bounding boxes are rejected.

## Text safety

- injected via argv (never a shell) — spaces, quotes, `$()`, backticks, pipes
  and leading dashes arrive literally
- NUL bytes refused
- maximum length 10000 by default (`--max-length` to raise)
- never logged by default; `--verbose` redacts; `--unsafe-debug` reveals

## Useful `niri msg action` list

Focus / move windows: `focus-window --id N`, `focus-window-previous`,
`move-window-to-workspace REF [--window-id N]`, `move-window-to-monitor NAME`,
`swap-window-left|right`, `center-window`.

Workspaces: `focus-workspace REF`, `focus-workspace-previous`,
`move-workspace-to-index N`, `set-workspace-name NAME`.

Layout: `maximize-column`, `maximize-window-to-edges`, `set-window-width|height CHANGE`,
`reset-window-height`, `switch-preset-column-width`, `toggle-column-tabbed-display`,
`set-column-display tabbed|normal`, `expel-window-from-column`,
`consume-window-into-column`, `toggle-windowed-fullscreen`.

Outputs: `focus-monitor NAME`, `move-window-to-monitor NAME`, `power-off-monitors`.

Misc: `close-window`, `fullscreen-window`, `spawn CMD...` (careful — it
launches), `screenshot-window` (interactive). Full list:
`niri msg action --help`.
