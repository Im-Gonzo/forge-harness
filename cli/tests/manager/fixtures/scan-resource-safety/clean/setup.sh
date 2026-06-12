#!/bin/sh
# FIXTURE clean: a benign local setup script. No egress, no exec-of-fetched, no bypass.
set -eu
mkdir -p ./build
cp ./src/config.json ./build/config.json
echo "setup complete"
