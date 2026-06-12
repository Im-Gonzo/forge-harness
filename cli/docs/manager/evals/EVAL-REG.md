# EVAL-REG — Registry acceptance specs

> RED-first acceptance specs for the registry (SPEC-01, BR-REG). All code-graded and deterministic
> (`pass^k=1.00`). None implemented yet → every case **RED**. Phase v0.2.

### EVAL-REG-001 — Registry location; no lock file

- **Verifies:** BR-REG-001
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture library, When `forge registry build --write` runs, Then it
  creates `forge/.forge/registry.json` and (on mutation) `forge/.forge/registry.log.jsonl`, and creates
  **no** `*.lock` file anywhere under `forge/.forge/`.
- **Fixture:** `fixtures/lib-min/` (a few agents/rules/a hook in `hooks.json`).
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-002 — Stale registry is an ERROR

- **Verifies:** BR-REG-002
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a committed `registry.json` whose catalog has drifted **structurally** from
  a fresh in-memory rebuild — a uid was added or removed (e.g. an artifact FILE deleted), or a shared
  artifact's `{kind,id,path,status,modules}` changed — When `lint/validate-registry.mjs` runs, Then it emits
  an ERROR whose message contains `registry stale, run forge registry build --write` and exits 1.
  (A content-only hash change with the same structural identity is the advisory WARN of EVAL-VER-007, **not**
  a stale ERROR.)
- **Fixture:** `fixtures/lib-min/` + a committed registry, then a structural change (delete an artifact file
  so its uid is removed). Seed the committed registry with the direct script
  `node manager/registry.mjs build --write <root>`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-003 — Scan surface and kind→path resolution

- **Verifies:** BR-REG-003
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a fixture with one artifact of each kind (agent, skill `SKILL.md`,
  command, nested rule, bundle, validator, meta-test, engine script, and a hook id in `hooks.json`), When
  `build` runs, Then there is exactly one record per real artifact, hooks are recorded by id with
  `path: "hooks/hooks.json#<id>"`, and each record's `kind`/`path` equals what `manager/lib/resolve-kind.mjs`
  yields.
- **Fixture:** `fixtures/lib-allkinds/`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-004 — Record shape and `modules[]` reverse-index

- **Verifies:** BR-REG-004
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given the fixture library, When `build` runs, Then every record validates
  against the SPEC-01 schema with all fields present and typed (`uid,kind,id,path,contentHash,revision,
  version,status,criticality,owner,description,tags,modules,dependsOn,eval,createdAt,updatedAt`), and a
  record's `modules[]` equals the set of modules whose `components` name it in `modules.json` (e.g.
  `agent:code-reviewer` → `["review"]`).
- **Fixture:** `fixtures/lib-min/` + the real `manifests/modules.json`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-005 — Planned vs orphan classification

- **Verifies:** BR-REG-005
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a manifest that names a component with **no file** and a file present in
  **no module**, When `build` runs, Then the first gets `status: "planned"` and is NOT reported as an
  error, and the second is flagged as an orphan (not `planned`).
- **Fixture:** `fixtures/lib-planned-and-orphan/`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-006 — Idempotent, deterministic build

- **Verifies:** BR-REG-006
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given an unchanged tree, When `build --write` runs twice, Then the two
  `registry.json` outputs are byte-identical and the second run appends **zero** new `registry.log.jsonl`
  lines.
- **Fixture:** `fixtures/lib-min/`.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-007 — Mutation log entry shape

- **Verifies:** BR-REG-007
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a committed registry, When an artifact is bumped, Then exactly one new
  `registry.log.jsonl` line is appended with `{ts,uid,from{hash,rev,ver},to{hash,rev,ver},reason,
  evalStatus}` whose `from` matches the prior record and `to` matches the new record, and all prior log
  lines are byte-unchanged.
- **Fixture:** `fixtures/lib-min/` + committed registry/log.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-008 — VERSION triple-drift is reported

- **Verifies:** BR-REG-008
- **Kind:** regression
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** The `-design` pre-release suffix is **stripped** before comparing
  `VERSION` / `package.json` / `.claude-plugin/plugin.json`, so drift means the **core** versions differ.
  Given the drifted fixture (`VERSION` = `0.2.0`, `package.json` = `0.1.0`, `plugin.json` = `0.1.0`), When
  `validate-registry` runs, Then it emits a `version triple drift:` WARN naming all three **raw** values.
  Given the **real** repo (`VERSION` = `0.1.0-design`, the JSON pair = `0.1.0`), Then — because the strip
  aligns the core versions — it reports **no** version-drift finding.
- **Fixture:** `fixtures/versions-drifted/` (drift) + the real repo root (clean after strip).
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-009 — Query verbs are read-only and correct

- **Verifies:** BR-REG-009
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a built registry, When `ls --kind agents`, `show <uid>`, and
  `changed --since <ref>` run, Then `ls --kind agents` returns only agent records, `show <uid>` returns the
  one record, `changed --since` lists exactly the uids whose `revision` advanced since `<ref>`, and no
  command modifies `registry.json` or the log (mtime + bytes unchanged).
- **Fixture:** `fixtures/lib-min/` with two registry snapshots differing by one bump.
- **Phase:** v0.2
- **Status:** GREEN

### EVAL-REG-010 — Build is fail-open on a bad artifact

- **Verifies:** BR-REG-010
- **Kind:** capability
- **Grader:** code
- **Target:** pass^k=1.00
- **Given / When / Then:** Given a library with one unreadable/malformed artifact among valid ones, When
  `build` runs, Then it records all valid artifacts, emits exactly one finding for the bad one in the
  `{level,path,line,message,source:"validate-registry"}` shape, and does NOT abort (exit reflects findings,
  not a crash).
- **Fixture:** `fixtures/lib-one-bad/`.
- **Phase:** v0.2
- **Status:** GREEN
