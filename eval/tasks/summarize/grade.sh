#!/usr/bin/env bash
N=0
for w in deploy cache latency retry quota; do grep -qi "$w" summary.md 2>/dev/null && N=$((N+1)); done
L=$(wc -l < summary.md 2>/dev/null || echo 999)
if [ "$N" = 5 ] && [ "$L" -le 40 ]; then echo '{"reward": 1}'; exit 0; fi
echo "{\"reward\": 0, \"detail\": \"found $N/5 words, $L lines\"}"; exit 1
