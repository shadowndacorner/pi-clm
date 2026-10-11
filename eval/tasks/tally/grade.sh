#!/usr/bin/env bash
SUM=$(awk -F, 'NR>1 {s+=$1} END {print s}' data.csv)
if [ -f result.json ] && grep -q "\"sum\"[[:space:]]*:[[:space:]]*${SUM}\b" result.json; then
  echo '{"reward": 1}'; exit 0
fi
echo '{"reward": 0}'; exit 1
