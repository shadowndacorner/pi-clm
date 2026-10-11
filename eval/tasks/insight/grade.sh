#!/usr/bin/env bash
if [ -f answer.md ] && grep -q "timeout-417" answer.md; then echo '{"reward": 1}'; exit 0; fi
echo '{"reward": 0}'; exit 1
