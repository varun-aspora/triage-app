#!/usr/bin/env bash
# Start or wait for a traced triage-shivalik Claude Code session.
#
#   shivalik_session.sh start <ref-id> [<session-name>]
#       runs `tracing-braintrust.sh <ref-id> <session-name>` in triage-shivalik, in a terminal:
#         - inside herdr (HERDR_ENV=1): a new tab in the current workspace, tab and pane named <session-name>
#         - otherwise a new window of the first app found: Ghostty, Alacritty, iTerm, Terminal
#       The shell stays open after claude exits, so the user can step in.
#       <session-name> defaults to triage-shivalik-<ref-id>; it is the display and Remote Control name.
#       tracing-braintrust.sh makes a UUID ref id the Claude session id too.
#   shivalik_session.sh wait <ref-id>
#       waits until the session has finished the turn that started with "Triage using ref_id: <ref-id>";
#       prints the transcript path
set -euo pipefail

SHIV=/Users/varun/code/work/triage-shivalik
TRANSCRIPTS="$HOME/.claude/projects/-Users-varun-code-work-triage-shivalik"

open_terminal() {
  local name=$1 run=$2
  if [ "${HERDR_ENV:-}" = 1 ] && command -v herdr >/dev/null; then
    local out pane
    out=$(herdr tab create ${HERDR_WORKSPACE_ID:+--workspace "$HERDR_WORKSPACE_ID"} --cwd "$SHIV" --label "$name" --no-focus)
    pane=$(jq -r '.result.root_pane.pane_id // empty' <<<"$out")
    [ -n "$pane" ] || { echo "herdr tab create failed: $out" >&2; return 1; }
    herdr pane rename "$pane" "$name" >/dev/null
    herdr pane run "$pane" "$run" >/dev/null
    echo "herdr pane $pane" >&2
    return
  fi

  # A new window: set its title, cd, run, then hand over to a login shell.
  local cmd
  cmd="printf '\\033]0;%s\\007' $(printf %q "$name"); cd $(printf %q "$SHIV") && $run; exec \$SHELL -l"
  has_app() { [ -d "/Applications/$1.app" ] || [ -d "$HOME/Applications/$1.app" ]; }
  as_quote() { local s=${1//\\/\\\\}; printf '"%s"' "${s//\"/\\\"}"; }
  if has_app Ghostty; then
    open -na Ghostty.app --args -e /bin/zsh -lc "$cmd"; echo ghostty >&2
  elif has_app Alacritty; then
    open -na Alacritty.app --args -e /bin/zsh -lc "$cmd"; echo alacritty >&2
  elif has_app iTerm; then
    osascript -e "tell application \"iTerm\" to tell (create window with default profile) to tell current session to write text $(as_quote "$cmd")" >/dev/null
    echo iterm >&2
  else
    osascript -e "tell application \"Terminal\" to do script $(as_quote "$cmd")" -e 'tell application "Terminal" to activate' >/dev/null
    echo terminal >&2
  fi
}

case "${1:-}" in
  start)
    ref=${2:?ref id}
    name=${3:-triage-shivalik-$ref}
    open_terminal "$name" "$(printf '%q ' ./tracing-braintrust.sh "$ref" "$name" --permission-mode auto)"
    # Wait for the claude process, so the caller can look for the session right away.
    for _ in $(seq 30); do pgrep -f -- "--remote-control $name" >/dev/null && break; sleep 2; done
    pgrep -f -- "--remote-control $name" >/dev/null || { echo "session $name did not start; check its terminal" >&2; exit 1; }
    echo "$name"
    ;;
  wait)
    ref=${2:?ref id}
    deadline=$(( $(date +%s) + ${WAIT_MINUTES:-120} * 60 ))
    while :; do
      f=$(grep -l "Triage using ref_id: $ref" "$TRANSCRIPTS"/*.jsonl 2>/dev/null | head -1 || true)
      # Done once a turn_duration entry follows the line holding the prompt.
      if [ -n "$f" ] && python3 - "$f" "$ref" <<'PY'
import json, sys
path, ref = sys.argv[1], sys.argv[2]
seen = False
for line in open(path):
    if f'Triage using ref_id: {ref}' in line:
        seen = True
        continue
    if seen:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('type') == 'system' and e.get('subtype') == 'turn_duration':
            sys.exit(0)
sys.exit(1)
PY
      then
        echo "$f"
        exit 0
      fi
      [ "$(date +%s)" -lt "$deadline" ] || { echo "shivalik session for $ref has not finished after ${WAIT_MINUTES:-120} min" >&2; exit 1; }
      sleep 30
    done
    ;;
  *) echo "usage: shivalik_session.sh start <ref-id> [<session-name>] | wait <ref-id>" >&2; exit 2 ;;
esac
