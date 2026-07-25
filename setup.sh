#!/usr/bin/env bash
# Pi config setup.
#
# Provisions the Programmatic Tool Calling (PTC) Python environment:
#   1. installs Python 3.14 via uv
#   2. creates the PTC venv at ~/.cache/pi-ptc/python-env
#   3. installs the scientific stack (matplotlib, numpy, pandas, pillow)
#
# PTC auto-detects that venv and uses it for code_execution, so the np / pd / plt
# pre-imports and matplotlib figure capture work out of the box.
#
# REQUIREMENT: uv must be on your PATH. Install it from https://docs.astral.sh/uv/
#   curl -LsSf https://astral.sh/uv/install.sh | sh
#
# Run from anywhere:   bash ~/.pi/agent/setup.sh
# Or inside pi:         /setup
set -euo pipefail

VENV_DIR="${HOME}/.cache/pi-ptc/python-env"
PY_VERSION="3.14"

if ! command -v uv >/dev/null 2>&1; then
	echo "ERROR: 'uv' was not found on your PATH." >&2
	echo "       It is required for setup. Install it:" >&2
	echo "       curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
	exit 1
fi

echo "==> Installing Python ${PY_VERSION} via uv (if not already)..."
uv python install "${PY_VERSION}"

echo "==> Creating PTC venv at ${VENV_DIR} (uv, Python ${PY_VERSION})..."
uv venv --clear --python "${PY_VERSION}" "${VENV_DIR}"

echo "==> Installing matplotlib, pandas, pillow (numpy comes as a dependency)..."
uv pip install --python "${VENV_DIR}/bin/python" matplotlib pandas pillow

echo "==> Verifying..."
"${VENV_DIR}/bin/python" - <<'PY'
import matplotlib, numpy, pandas, PIL
print(f"matplotlib {matplotlib.__version__} | numpy {numpy.__version__} | pandas {pandas.__version__} | pillow {PIL.__version__}")
PY

echo "==> Done. PTC plotting (np / pd / plt) is ready in ${VENV_DIR}."
