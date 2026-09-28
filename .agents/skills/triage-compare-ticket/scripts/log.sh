#!/usr/bin/env bash
# The log of tickets already sent to both agents: triage-app/.data/compare-runs.jsonl (gitignored).
#
#   log.sh seen                                  ticket numbers already processed, one per line
#   log.sh add <ticket> <ref-id> <run-id>        append one processed ticket
set -euo pipefail

LOG=/Users/varun/code/work/triage-app/.data/compare-runs.jsonl
mkdir -p "$(dirname "$LOG")"

case "${1:-}" in
  seen) [ -f "$LOG" ] && jq -r '.ticket' "$LOG" | sort -u || true ;;
  add)
    jq -nc --arg t "${2:?ticket}" --arg r "${3:?ref id}" --arg a "${4:?run id}" --arg at "$(date -u +%FT%TZ)" \
      '{ticket: $t, ref_id: $r, run_id: $a, shivalik_session: ("triage-shivalik-" + $r), at: $at}' >>"$LOG"
    ;;
  *) echo "usage: log.sh seen | add <ticket> <ref-id> <run-id>" >&2; exit 2 ;;
esac
