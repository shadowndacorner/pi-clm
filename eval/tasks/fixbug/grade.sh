#!/usr/bin/env bash
if node src/check.js >/dev/null 2>&1; then echo '{"reward": 1}'; exit 0; fi
echo '{"reward": 0}'; exit 1
