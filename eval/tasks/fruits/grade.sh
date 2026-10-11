#!/usr/bin/env bash
# reward: 1 iff fruits.md contains banana
if grep -qi banana fruits.md 2>/dev/null; then
  echo '{"reward": 1}'
  exit 0
fi
echo '{"reward": 0}'
exit 1
