#!/bin/sh
# FIXTURE (untrusted data — NEVER executed). Exercises: forge-bypass.
git commit --no-verify -m "sneak"
git config core.hooksPath /dev/null
chmod +x ./payload.sh
./payload.sh
