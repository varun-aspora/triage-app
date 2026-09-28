#!/usr/bin/env bash
# Start or wait for a triage-app run over its HTTP API.
#
#   app_run.sh check                         prints the server URL if it is running
#   app_run.sh start <query-file> <ref-id>   POST /triage with the file's text as the only message; prints the run id
#   app_run.sh wait  <run-id>                polls GET /triage/<run-id> until the run stops moving; prints phase and report status
#
# Reads TRIAGE_HTTP_PORT and TRIAGE_HTTP_AUTH_TOKEN from triage-app/.env.
# Errors out when the server is not running; it never starts one.
set -euo pipefail

APP=/Users/varun/code/work/triage-app
env_val() { grep "^$1=" "$APP/.env" | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//'; }
PORT=$(env_val TRIAGE_HTTP_PORT); PORT=${PORT:-3006}
TOKEN=$(env_val TRIAGE_HTTP_AUTH_TOKEN)
BASE="http://localhost:$PORT"
[ -n "$TOKEN" ] || { echo "TRIAGE_HTTP_AUTH_TOKEN is not set in $APP/.env" >&2; exit 1; }

api() { curl -sS --max-time 30 -H "Authorization: Bearer $TOKEN" "$@"; }

if ! api -o /dev/null "$BASE/triage?limit=1" 2>/dev/null; then
  echo "triage-app is not running on $BASE. Start it with: cd $APP && bun run serve" >&2
  exit 1
fi

case "${1:-}" in
  check) echo "$BASE" ;;
  start)
    file=${2:?query file}; ref=${3:?ref id}
    body=$(jq -n --rawfile q "$file" --arg ts "$(date +%s).000000" \
      '{messages: [{ts: $ts, author: "requester", text: $q, is_parent: true}], requested_by: "triage-compare-ticket"}')
    out=$(api -X POST "$BASE/triage" -H 'Content-Type: application/json' -H "Idempotency-Key: $ref" -d "$body")
    run_id=$(jq -r '.run_id // empty' <<<"$out")
    [ -n "$run_id" ] || { echo "POST /triage failed: $out" >&2; exit 1; }
    echo "$run_id"
    ;;
  wait)
    run=${2:?run id}
    # needs_input and blocked are not terminal, but nothing runs until a person acts, so stop waiting.
    while :; do
      out=$(api "$BASE/triage/$run")
      phase=$(jq -r '.phase // empty' <<<"$out")
      stalled=$(jq -r 'if .stalled then "yes" else "" end' <<<"$out")
      case "$phase" in
        completed|failed|stopped|needs_input|blocked) break ;;
        '') echo "GET /triage/$run failed: $out" >&2; exit 1 ;;
      esac
      [ -z "$stalled" ] || break
      sleep 20
    done
    jq '{run_id, phase, stalled, report_status: (.report.status // null)}' <<<"$out"
    ;;
  *) echo "usage: app_run.sh check | start <query-file> <ref-id> | wait <run-id>" >&2; exit 2 ;;
esac
