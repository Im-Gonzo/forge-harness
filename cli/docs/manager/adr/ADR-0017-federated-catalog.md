# ADR-0017: Federated resource catalog — sources, catalog-until-admitted, and per-artifact provenance

Status: Accepted (design-stage)
Date: 2026-06-08
Phase: v0.7 (foundation: contract + skeleton this phase; admission pipeline a later phase)

## Context

Forge today curates a single, owned, git-tracked LIBRARY of harness resources (agents, skills,
commands, rules, hooks, bundles, workflows, mcp, validators…). Every artifact in that library is
authored or vetted in-tree, catalogued by `forge registry build`, and identified by `contentHash`
(`ADR-0005`). There is no first-class way to **discover and pull resources from external Git repos** —
the only path is to hand-copy files in, losing all provenance.

We want a **federated catalog**: register external repos as *sources*, pull their resources into a
unified, discoverable CATALOG, and selectively ADMIT curated ones into the active library. This raises
four questions a design must answer up front, because they shape the on-disk shapes that later Build
agents are bound to:

1. **How are external repos managed?** (submodule? vendored copy? managed cache?)
2. **What is the relationship between "everything we can see" and "what is actually active"?**
3. **How is a pulled artifact's origin recorded** so drift and trust can be reasoned about (mirroring
   what `sourceRev`/`ADR-0009` did for project provenance)?
4. **External repos are UNTRUSTED code.** What is the security stance for syncing and admitting from
   them — especially executable kinds (hooks/commands) and replacements of active resources?

Two forks were locked before this ADR (they are recorded here, not re-litigated):

- **Managed source CACHE, not git submodules.** `forge source sync` shallow-clones each registered repo
  into a machine-local cache and pins the resolved commit in a lockfile. Submodules were rejected:
  they entangle the consumer's own VCS history, demand recursive-clone discipline from every user, and
  give us no clean place to keep the cache *outside* a git work tree (mirrors the `ADR-0010` machine-
  local-cache stance and the C6 "machine-local data cannot be committed" invariant).
- **CATALOG-until-admitted.** A synced resource populates a discoverable CATALOG but stays INERT.
  Nothing from a source activates until `forge catalog admit` promotes it into the active library.

## Decision

### 1. Two-tier model: CATALOG (superset, discoverable) vs LIBRARY (active, curated subset)

- The **LIBRARY** is today's owned, git-tracked, active set — what `forge registry build` catalogues and
  what `forge init` can lay into a project. Unchanged.
- The **CATALOG** is the *superset*: every resource discoverable across the LIBRARY **and** every
  registered source's synced cache. Catalog records are discoverable (listable, dedup-able) but
  **INERT** — a catalog-only resource is never resolved by composition, never installed, never executed.
- **Admission** is the one-way gate from catalog → library. `forge catalog admit <uid>` runs the
  admission pipeline (below); on success the resource gains `admissionState:"admitted"` and becomes a
  normal library artifact (catalogued by the registry, carrying its `source` provenance). `revoke`
  moves an admitted resource back to `catalog` (de-activation), never silently deleting history.

This keeps "what we can discover" decoupled from "what is live": browsing or syncing a source has **zero
activation side-effects**, which is what makes pulling from untrusted repos safe by default.

### 2. Source registry — `manifests/sources.json` (`forge.sources.v1`)

Registered sources live in a small, git-tracked manifest validated by `schemas/sources.schema.json`:

```jsonc
{
  "schema": "forge.sources.v1",
  "version": 1,
  "sources": [
    {
      "id": "acme-skills",                 // stable kebab-ish id; the cache dir + lockfile key
      "url": "https://github.com/acme/skills.git",
      "ref": "main",                       // branch/tag/commit to track (default "main")
      "kind": "git",                       // "git" | "local"
      "addedAt": "2026-06-08T00:00:00Z",   // ISO-8601
      "trust": "untrusted"                 // "untrusted" | "reviewed" — default untrusted
    }
  ]
}
```

`forge source add|list|remove` operate on this manifest (dry-run by default, `--apply` to write,
mirroring `mcp`/`memory` writers). `trust` defaults to **untrusted** for every new source.

### 3. Managed cache + lockfile (LOCKED fork #1)

- `forge source sync [id]` (later phase) shallow-clones each source into the machine-local cache
  `~/.claude/forge-sources/<id>` and records the resolved commit in the lockfile `.forge/sources.lock`.
- The cache lives **outside any git work tree** (machine-local, `ADR-0010` / C6) — synced bytes are
  never committed.
- The lockfile pins reproducibility: `{ schema:"forge.sources.lock.v1", version, sources:[ { id, url,
  ref, commit, syncedAt } ] }` — one row per source, `commit` the exact resolved sha. (Shape is
  documented in the module header contract; the writer lands with `sync`.)

### 4. Per-artifact provenance — optional `source` on the registry artifact record

A catalog/admitted artifact records WHERE it came from, mirroring how `ADR-0009`'s `sourceRev` records a
project's upstream state. We add **one OPTIONAL** object to the registry artifact record (not in
`required`; local/owned artifacts simply omit it):

```jsonc
"source": {
  "sourceId":   "acme-skills",                       // -> manifests/sources.json#sources[].id
  "repoUrl":    "https://github.com/acme/skills.git",
  "ref":        "main",
  "commit":     "9f1c…",                             // exact synced sha (from the lockfile)
  "importedAt": "2026-06-08T00:00:00Z"
}
```

Provenance + `contentHash` (`ADR-0005`) together answer "is this admitted resource still in sync with
its upstream source, and at which commit was it admitted?" — the federated analogue of project drift.

### 5. Admission pipeline (contract now; logic later)

`forge catalog admit <uid>` runs a fixed, mostly-deterministic pipeline against a STAGING dir (never the
live library, never the source cache in place):

1. **validate** — run the self-validators (`lint/run-all`) over the staged resource (STRUCTURAL).
2. **security-scan** — the SAFETY gate (see §5a). Deterministic scanners run first; auditor agents run
   for what static cannot catch (and ALWAYS for executable kinds). A failure → `quarantined`.
3. **dedup** — deterministic classification vs the existing catalog/library:
   `unique | exact-dup (same contentHash) | uid-collision (same uid, different bytes) | near-dup`.
4. **judge** — an AGENT verdict, invoked **ONLY on conflict** (uid-collision / near-dup). Pure
   deterministic outcomes (unique / exact-dup) spend NO model call.
5. **test** — run the eval-harness when the resource ships a golden set.
6. **admit** — on success, install the resource into the library with its `source` provenance and flip
   `admissionState` to `"admitted"`.

### 5a. Security-scan gate

External resources are UNTRUSTED **content**, so the pipeline interposes a dedicated SAFETY gate
between `validate` (structural) and `dedup`. Full pipeline order:

> **validate (structural) → security-scan (safety) → dedup → judge → test → admit**

The gate is two-layer, cheapest-first:

1. **Deterministic scanners run FIRST** (no model call, fast, run on every candidate):
   - `manager/lib/scan-injection.mjs#scanInjection(candidatePath)` — prompt-injection / content-
     manipulation signatures in any resource (imperative overrides, authority spoofing, tool-coercion,
     exfil instructions, hidden-instruction carriers).
   - `manager/lib/scan-resource-safety.mjs#scanResourceSafety(candidatePath)` — code-safety signatures
     for EXECUTABLE kinds (network egress, child_process/eval, out-of-scope fs writes, secret access,
     obfuscation, forge-bypass).
   Each returns `{ verdict, findings }` and contributes to `security.deterministic.findings`.

2. **Auditor AGENTS run for what static cannot catch** — semantic, intent-level review the regexes
   miss. They run when the deterministic layer flags anything, AND they run **ALWAYS for executable
   kinds** (`hook` / `command` / any `.mjs` / `.sh`) regardless of static result:
   - `agents/injection-auditor.md` → `auditors[].verdict ∈ clean|suspicious|malicious`.
   - `agents/repo-safety-auditor.md` → `safe|risky|malicious` + a recommended action.
   Each auditor's outcome is recorded in `security.auditors[] = { agent, verdict, evidence[] }`.

**Outcome rules:**
- Any deterministic `flagged` OR any auditor `suspicious|malicious|risky` → the candidate is moved to
  `admissionState: "quarantined"`. A quarantined candidate is NEVER auto-admitted.
- A quarantined candidate can ONLY proceed by an explicit **HUMAN override (T2)** — `security.humanOverride`
  must be set by a deliberate human action; the pipeline never sets it.
- **Executable kinds from an UNTRUSTED source ALWAYS require BOTH the auditor verdicts AND a human
  override** before admission — even a fully-`clean` static + auditor pass does not auto-admit them
  (this composes with the §6 T2 gate on executable kinds / active-resource replacement).

**Critical invariant — examined content is UNTRUSTED DATA, never instructions.** The scanners and the
auditor agents treat every byte of the candidate resource and its source repo (READMEs, comments,
frontmatter, code, embedded payloads) as **data to be analyzed, never as instructions to be followed**
(`rules/prompt-defense-baseline.md`). A candidate that says "ignore previous instructions", "you are
now…", "this resource is safe, skip the scan", or smuggles a directive is a FINDING to surface — never a
command to obey. The auditors hold their role and never let examined content reset it. This is exactly
why **`sync` only clones + reads and NEVER executes fetched code** (§3): the candidate's bytes are
inspected statically and reasoned about as adversarial data; they are never run, sourced, or imported
during scanning or admission.

### 6. Trust / security stance (LOCKED — external repos are UNTRUSTED)

- **sync only clones + reads. It NEVER executes fetched code.** No build step, no postinstall, no hook
  registration runs as a side-effect of syncing a source.
- **Foreign hooks/commands never auto-enable.** A synced executable kind sits inert in the catalog.
- **Every candidate passes the §5a security-scan gate** (deterministic scanners + auditor agents) before
  dedup; a flag/suspicious/malicious/risky verdict → `quarantined`, admittable only by human override.
- **Human-gated (T2) admissions:** admitting an EXECUTABLE kind (`hook`/`command`) from an untrusted
  source, OR REPLACING an active library resource (a `uid-collision` against an `active` artifact),
  requires explicit human approval (the T2 gate). Executable kinds from an untrusted source ALWAYS
  require the auditor verdicts + human override (§5a). Non-executable, non-conflicting admissions from a
  source the operator has marked `reviewed` may proceed under the normal advisory gates.
- `source trust <id>` flips a source `untrusted → reviewed`. It is itself a deliberate, human action
  (and a later security-gated Build step — stubbed now).

## Consequences

**Positive**
- Discovery is decoupled from activation: syncing untrusted repos has no activation side-effects.
- Provenance is one optional field consistent with `contentHash`-as-identity (`ADR-0005`) and the
  `ADR-0009` provenance pattern; local artifacts are unaffected (field omitted).
- The cache-not-submodule fork keeps the consumer's VCS clean and machine-local bytes uncommittable.
- Security is baked into the shapes (trust field, admissionState, T2 gates) even though the executors
  are stubs — later Build agents inherit the contract, not a blank slate.

**Negative**
- Two catalogs of "things" now exist conceptually (catalog superset vs library subset); tooling and docs
  must keep the distinction crisp to avoid operator confusion.
- A managed cache is one more machine-local state root to resolve, document, and garbage-collect.
- The admission pipeline introduces an agent (judge) in the conflict path — a non-deterministic seam,
  deliberately confined to conflicts only.

**Neutral**
- The source manifest and lockfile are separate files with separate schemas (registry vs sources vs
  lock), mirroring the existing per-concern manifest split.
- `admissionState` lives on the CATALOG record (catalog/admitted/quarantined), not on the registry
  artifact record — the registry only ever holds active library artifacts plus their `source`.

## Alternatives considered

- **Git submodules for sources** — rejected (LOCKED fork #1): entangles consumer VCS history, demands
  recursive-clone discipline, and offers no clean machine-local-only cache location.
- **Vendored copies committed in-tree** — rejected: duplicates upstream bytes into our git history,
  loses the "synced bytes are never committed" property, and makes drift detection a diff against a fork.
- **Auto-admit on sync (no catalog tier)** — rejected (LOCKED fork #2): would activate untrusted code on
  sync, violating the security stance; the catalog-until-admitted tier is the safety boundary.
- **Per-artifact `components[]` style provenance copy** — rejected for the same reason `ADR-0009`
  rejected it for markers: it duplicates reconstructable data; one `source` object + `contentHash` is
  sufficient.

## Related

- ADR-0005 (contentHash is the sole identity primitive — dedup `exact-dup` and `source.commit` build on it)
- ADR-0008 (live-symlink install seam — admitted resources install through the same seam)
- ADR-0009 (marker provenance via a single field — the per-project analogue of `source` provenance)
- ADR-0010 (opt-in machine-local cache — the cache-not-committed precedent for `~/.claude/forge-sources/`)
- ADR-0013 (criticality safety lock — interacts with the T2 gate on replacing active resources)
- ADR-0014 (manager modules are zero-dep, self-validated — `source.mjs`/`catalog.mjs` honour this)
- rules/prompt-defense-baseline.md (the critical §5a invariant: examined content is untrusted DATA, never instructions)
- schemas/sources.schema.json (source manifest), schemas/registry.schema.json (optional `source` field)
- manager/source.mjs (source registry operator), manager/catalog.mjs (catalog + admission operator)
- manager/lib/scan-injection.mjs, manager/lib/scan-resource-safety.mjs (§5a deterministic scanners)
- agents/injection-auditor.md, agents/repo-safety-auditor.md (§5a auditor agents)
