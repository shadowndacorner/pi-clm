#!/usr/bin/env bash
# Live coexistence smoke: proves parent AND spawned child pi sessions both
# initialize the CLM extension (opt-in, uses real model calls).
#
#   scripts/live-coexistence-smoke.sh [pi binary] [prompt]
#
# Mechanism: PI_CLM_SMOKE_MARKER records every session_start handled by the
# plugin. pi-subagents' required-child-extensions registry injects the plugin
# into `--no-extensions` children; the marker file must therefore contain
# entries for >= 2 distinct sessions (parent + child).
set -euo pipefail
cd "$(dirname "$0")/.."
FORK_ROOT="$(pwd)"
SUBAGENTS="${PI_SUBAGENTS_ROOT:-$HOME/.pi/agent/npm/node_modules/pi-subagents}"
STAMP="$(date +%s)"
MARKER="/tmp/pi-clm-coexistence-smoke-$STAMP.log"
: > "$MARKER"
PARENT_OUT="/tmp/pi-clm-coexistence-smoke-parent.out"
PARENT_ERR="/tmp/pi-clm-coexistence-smoke-parent.err"

PROMPT="${2:-Use the subagent tool exactly once with {agent: \"delegate\", task: \"Reply with exactly: COEXISTING-CHILD-OK\"}. Then reply PARENT-OK.}"
if [ "${1:-pi}" = "pi" ]; then PI_BIN="pi"; else PI_BIN="$1"; fi

echo "[smoke] parent: $PI_BIN -e $FORK_ROOT (pi-subagents: $SUBAGENTS)"
env PI_CLM_SMOKE_MARKER="$MARKER" \
  "$PI_BIN" -e "$FORK_ROOT" --no-session -p --mode text "$PROMPT" \
  > "$PARENT_OUT" 2> "$PARENT_ERR" || true
echo "[smoke] parent stdout tail:"; tail -3 "$PARENT_OUT" || true
echo "[smoke] parent stderr tail:"; tail -3 "$PARENT_ERR" || true
echo "[smoke] marker entries:"; cat "$MARKER"

SESSIONS="$(grep -c "session" "$MARKER" || true)"
UNIQUE="$(grep -o "session [^ ]*" "$MARKER" | sort -u | wc -l | tr -d ' ')"
echo "[smoke] session lines: $SESSIONS, distinct sessions: $UNIQUE"
if [ "$UNIQUE" -ge 2 ]; then
  echo "[smoke] PASS: parent + at least one child CLM session coexisted"
  exit 0
fi
echo "[smoke] FAIL: fewer than 2 distinct CLM sessions recorded (child did not initialize?)"
exit 1
