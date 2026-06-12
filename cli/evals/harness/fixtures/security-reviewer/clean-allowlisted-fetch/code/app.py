"""Webhook-relay microservice — the CLEAN trap for security-reviewer.

This file deliberately *resembles* the SSRF fixture (an outbound `requests.get`
whose host is influenced by caller input) but is CORRECT: the destination host is
confined to a fixed allowlist BEFORE any request is made, so an attacker cannot
pivot the fetch to 169.254.169.254 or any internal range. It also plants traps
harvested from security-reviewer's own "Common false positives — do NOT report"
list: a public, publishable Stripe key, and a non-crypto MD5 used purely as a
cache key. A correct review of this file returns ZERO findings.

Ground truth: see ../EXPECTED.json — empty defects[], the resemblances marked as
clean_traps[] the reviewer must stay silent on.
"""

import hashlib
import os
from urllib.parse import urlparse

import requests
from flask import Flask, abort, jsonify, request

app = Flask(__name__)

# A publishable Stripe key is DESIGNED to be public (client-side). Per the
# reviewer's do-NOT-report list, flagging this as a leaked secret is a false
# positive. (Trap line — must stay quiet.)
STRIPE_PUBLISHABLE_KEY = "pk_live_51HxYzAbCdEfGhIjKlMnOpQrS"

# The ONLY hosts this relay may ever contact. User input is confined to these.
PARTNER_HOSTS = frozenset({"hooks.partner-one.example", "events.partner-two.example"})

RELAY_TIMEOUT_SECONDS = 5


def _is_allowed(url):
    """True only when the URL is https and its host is on the fixed allowlist.

    This is the control that makes the outbound fetch safe — an attacker-supplied
    host that is not on PARTNER_HOSTS is rejected before any request is issued.
    """
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname in PARTNER_HOSTS


def _idempotency_cache_key(payload_bytes):
    """MD5 here is a CACHE KEY, not a security primitive (no passwords, no auth).

    Per the reviewer's do-NOT-report list, flagging non-crypto MD5 used for
    dedup/jitter is security theater. (Trap line — must stay quiet.)
    """
    return hashlib.md5(payload_bytes).hexdigest()


@app.route("/relay", methods=["POST"])
def relay():
    """Relay a webhook to a caller-named partner — but only an allowlisted one."""
    target = request.args.get("to", "")
    if not _is_allowed(target):
        abort(400, "destination host is not an approved partner")
    body = request.get_data()
    key = _idempotency_cache_key(body)
    resp = requests.post(target, data=body, timeout=RELAY_TIMEOUT_SECONDS)
    return jsonify({"relayed_to": target, "idempotency_key": key, "status": resp.status_code})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8081")))
