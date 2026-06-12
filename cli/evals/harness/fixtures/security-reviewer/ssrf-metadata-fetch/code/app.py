"""Link-preview microservice.

Production-shaped Flask app. One endpoint (`/preview`) fetches a remote URL the
caller supplies and returns a small preview blob. The PLANTED DEFECT is a classic
SSRF: the user-controlled `?next=` URL flows straight into `requests.get` with no
allowlist, no scheme check, and no block on internal/link-local ranges — so a
caller can pivot the server to the cloud metadata endpoint (169.254.169.254) and
read instance credentials.

Ground truth: see ../EXPECTED.json (defect at app.py:42, class SSRF, min HIGH).
"""

import os
import re

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

# A short read timeout — defensible and NOT a finding (it limits, it does not
# control the destination). Clean line; the reviewer must stay quiet on it.
PREVIEW_TIMEOUT_SECONDS = 5

# Maximum bytes to pull from a previewed page. Clean line.
PREVIEW_MAX_BYTES = 64 * 1024


def _summarize(html):
    """Trim a fetched HTML body down to a title-ish preview. Pure string work."""
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:200]


@app.route("/preview")
def preview():
    """UNAUTHENTICATED handler. `next` is fully attacker-controlled (see below)."""
    # No auth decorator. No URL validation. No allowlist of permitted hosts.
    target = request.args.get("next", "")
    # `target` flows straight into the HTTP client below — attacker picks the host.
    resp = requests.get(target, timeout=PREVIEW_TIMEOUT_SECONDS)  # SSRF: no allowlist, no scheme/host check
    body = resp.content[:PREVIEW_MAX_BYTES].decode("utf-8", "replace")
    return jsonify({"url": target, "status": resp.status_code, "preview": _summarize(body)})


@app.route("/healthz")
def healthz():
    """Liveness probe. No user input reaches any sink here. Clean."""
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8080")))
