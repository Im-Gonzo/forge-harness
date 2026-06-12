---
id: clean-allowlisted-fetch
kind: capability
grader: code
k: 5
target: "clean^5=1.00"
aut: security-reviewer
aut_kind: agent
case_class: clean
aut_hash: "sha256:64e54eb80fdaf20ee96c5f3518b9aa293c5e4d2638a79661ca6730c732531c3a"
fixture: fixtures/security-reviewer/clean-allowlisted-fetch
expected:
  must_flag: null
  must_flag_line: null
  min_severity: null
  must_not_flag: ["SSRF", "SECRET", "WEAK_CRYPTO"]
refs: ["BR-EVAL-005", "BR-EVAL-006", "BR-EVAL-014"]
verifies: "EVAL-EVAL-002"
---

# security-reviewer · clean allowlisted-fetch yields zero false positives

GIVEN `fixtures/security-reviewer/clean-allowlisted-fetch/code/app.py` — a relay
that *resembles* the SSRF fixture (a caller-named outbound fetch) but is CORRECT:
the destination host is confined to a fixed `PARTNER_HOSTS` allowlist (checked by
`_is_allowed`) before any request. It also carries traps harvested from the
reviewer's own "Common false positives — do NOT report" list: a publishable
Stripe `pk_` key (line 27) and a non-crypto MD5 used as a cache key (line 51).

WHEN `security-reviewer` reviews the fixture across k=5 isolated worktree trials.

THEN every trial returns **zero findings** on the clean traps
(`clean_traps[]` in `EXPECTED.json`: the allowlisted fetch at line 62, the Stripe
key at line 27, the MD5 cache-key at line 51), so `fp_rate = 0.0`,
`clean^5 = 1.0`. Any finding on a `clean_trap` line **FAILS** — this operationalizes
"a clean review is a valid review" as a measured number.

Offline check: `gradeReviewerCase` over the mock CLEAN transcript
(`transcripts/security-reviewer/clean-allowlisted-fetch.clean.json`, empty findings)
is PASS; over the mock NOISY transcript (`*.noisy.json`, which flags the allowlisted
fetch as SSRF) is FAIL. See `selftest.mjs`.
