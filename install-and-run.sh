#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINUX_SCRIPT="$SCRIPT_DIR/scripts/linux/install-and-run.sh"

bash "$LINUX_SCRIPT"
