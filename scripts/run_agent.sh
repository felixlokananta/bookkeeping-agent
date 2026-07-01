#!/usr/bin/env bash
# Run the bookkeeping agent via repo-local pi
# Must be run from the repo root
#
# Disables pi's built-in coding tools (bash/read/edit/write/grep/find/ls) so
# only the 5 registered ledger tools are exposed:
#   1. Least privilege: a bookkeeping assistant has no reason to run shell
#      commands or edit arbitrary files.
#   2. Reliability: some tool-calling models (verified with a local vLLM
#      Qwen model) degrade badly once the tool schema list grows past ~5-6
#      tools, silently falling back to describing a call in plain text
#      instead of invoking it. Dropping the built-ins keeps the toolset
#      small and tool-calling reliable.
# Pass extra flags through, e.g. `scripts/run_agent.sh -p "..."`.

set -euo pipefail

exec npx pi --no-builtin-tools "$@"
