#!/usr/bin/env bash
# Find the Braintrust root span of each run.
#
#   find_spans.sh <ref-id> <run-id>
#
# shivalik (varun-test-2): the root whose metadata.session_id or metadata.reference_id is the ref id, or
#   any span whose input holds "ref_id: <ref-id>" (a session the user started and passed by name).
# triage-app (varun-test): root whose metadata."flue.instance_id" is the run id.
# Traces can land a little after a run ends, so each lookup retries for about two minutes.
# Prints JSON {"shivalik_span_id", "app_span_id"}; a missing one is null and the exit code is 1.
set -uo pipefail

ref=${1:?ref id}; run=${2:?run id}
BT=${BT:-$HOME/.local/bin/bt}

pid() { "$BT" projects list --json | jq -r --arg n "$1" '(if type == "array" then . else .items end)[] | select(.name == $n) | .id'; }
root() {
  for _ in 1 2 3 4 5 6; do
    id=$("$BT" sql --json --non-interactive "SELECT root_span_id FROM project_logs('$1') WHERE $2 LIMIT 1" \
      | jq -r '.data[0].root_span_id // empty')
    [ -n "$id" ] && { echo "$id"; return; }
    sleep 20
  done
}

since=$(date -u -v-3d +%FT%TZ)
shiv=$(root "$(pid varun-test-2)" "created > '$since' AND ((is_root = true AND (metadata.session_id = '$ref' OR metadata.reference_id = '$ref')) OR input ILIKE '%ref_id: $ref%')")
app=$(root "$(pid varun-test)" "is_root = true AND metadata.\"flue.instance_id\" = '$run'")

jq -n --arg s "$shiv" --arg a "$app" '{shivalik_span_id: ($s | select(. != "")), app_span_id: ($a | select(. != ""))}'
[ -n "$shiv" ] && [ -n "$app" ]
