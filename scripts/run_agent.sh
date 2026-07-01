#!/usr/bin/env bash
# Run the bookkeeping agent via repo-local pi
# Must be run from the repo root

set -euo pipefail

exec npx pi "$@"
