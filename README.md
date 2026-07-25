# pi-config

My [pi](https://github.com/earendil-works/pi-coding-agent) configuration.

Contents:

- `settings.json` — global pi settings (theme, default model, enabled packages).
- `extensions/` — user-scoped pi extensions (custom prompt, `/update`, `/setup`, …).
- `setup.sh` — provisions the Python environment for Programmatic Tool Calling (PTC).

## Setup

Run the setup script:

```sh
bash setup.sh
```

…or, from inside pi:

```
/setup
```

### Requirements

**[uv](https://docs.astral.sh/uv/) is required.** It must be on your `PATH` — the
script uses it to install Python 3.14 and manage the venv, which keeps setup fast,
reproducible, and isolated from your system Python.

Install it:

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### What `setup.sh` does

1. Installs **Python 3.14** via `uv python install`.
2. Creates the PTC virtualenv at `~/.cache/pi-ptc/python-env` (uv-managed).
3. Installs the scientific stack into it: `matplotlib`, `numpy`, `pandas`, `pillow`.

PTC auto-detects that venv and uses it for `code_execution`, so the `np` / `pd` /
`plt` pre-imports and matplotlib figure capture work out of the box.

> Keep `uv` installed — re-run `setup.sh` (or `/setup`) any time to refresh the
> environment.
