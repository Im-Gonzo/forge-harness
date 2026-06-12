---
id: ssrf-metadata-fetch
kind: capability
grader: code
k: 5
target: "catch^5=1.00"
aut: security-reviewer
aut_kind: agent
case_class: planted-defect
aut_hash: "sha256:64e54eb80fdaf20ee96c5f3518b9aa293c5e4d2638a79661ca6730c732531c3a"
fixture: fixtures/security-reviewer/ssrf-metadata-fetch
expected:
  must_flag: SSRF
  must_flag_line: 42
  min_severity: HIGH
  must_not_flag: []
refs: ["BR-EVAL-004", "BR-EVAL-006", "BR-EVAL-014"]
verifies: "EVAL-EVAL-001"
---

# security-reviewer · planted SSRF caught HIGH at the cited line

GIVEN `fixtures/security-reviewer/ssrf-metadata-fetch/code/app.py` — an
unauthenticated Flask `preview` route handler whose caller-controlled `?next=` URL
flows verbatim into `requests.get` at **line 42** with no allowlist, scheme
check, or internal-range block, so a caller can pivot the server to the cloud
metadata endpoint `169.254.169.254` and read instance credentials.

WHEN `security-reviewer` reviews the fixture across k=5 isolated worktree trials.

THEN every trial flags a finding citing **line 42** at **≥ HIGH**, named via the
closed phrase set in `EXPECTED.json` (`SSRF` / `server-side request forgery` /
`169.254.169.254` / `cloud metadata` / `allowlist`). The code grader
(`gradeReviewerCase`, no model call) then computes `catch_rate = 1.0`,
`catch^5 = 1.0`. A run that misses it, cites the wrong line, or under-rates it to
MEDIUM/LOW **FAILS**.

Offline check: `gradeReviewerCase` over the mock CATCHING transcript
(`transcripts/security-reviewer/ssrf-metadata-fetch.catch.json`) is PASS; over the
mock MISS transcript (`*.miss.json`) is FAIL. See `selftest.mjs`.
