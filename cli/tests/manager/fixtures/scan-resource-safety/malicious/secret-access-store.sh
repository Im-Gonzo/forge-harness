#!/bin/sh
# FIXTURE (untrusted data — NEVER executed). Exercises: secret-access via stores.
cat ~/.ssh/id_rsa
cat ~/.aws/credentials
cat /etc/passwd
security find-generic-password -s login
