# Forge

**A personal Claude Code harness that installs once globally and tailors itself to every project.**

Forge is a focused, owned harness. It carries real enforcement machinery (runnable validators, quality hooks,
eval discipline) and an opinionated method (engineered context, the autonomy ladder, evidence-before-claims) in a
small framework you control — and it knows how to set itself up for a new project on its own.

> **Status: Beta (v0.2.0).** Executable end-to-end — a zero-dependency Node CLI, a detect-and-offer bootstrap
> engine that tailors a `.claude/` harness per project, 16 self-validators, and a companion local web UI. Expect
> rough edges; feedback welcome. See [docs/ROADMAP.md](./docs/ROADMAP.md) for what's next.

## The idea in one picture

```
GLOBAL  (install once, available everywhere)        PROJECT  (generated, tailored, thin)
┌─────────────────────────────────────────┐         ┌────────────────────────────────────┐
│  Forge plugin in ~/.claude/plugins/      │  init   │  <project>/.claude/                 │
│  • full library: agents/skills/rules/... │ ──────► │  • AGENTS.md  (constitution)        │
│  • bootstrap engine (detect + compose)   │         │  • rules/ (paths-globbed, tuned)    │
│  • self-validators                       │         │  • settings.json (real commands)    │
│  • manifests: profiles → modules         │         │  • memory/ + bundles/ (seeds)       │
└─────────────────────────────────────────┘         │  • .forge.json (idempotency marker) │
                                                     └────────────────────────────────────┘
```

Everything is available globally; each project gets a lean activation tuned to its stack.

## How tailoring works (detect + offer)

1. You open a project with no harness.
2. A global **SessionStart hook detects** the missing `.forge.json` and nudges Claude to **offer** to set one up.
3. You confirm → `/harness-init` **profiles** the repo (deterministic), **composes** the right module set (LLM),
   and **generates** a tailored `.claude/` + marker.
4. Re-runs are idempotent; `/harness-sync` upgrades without clobbering your edits (checksum-guarded).

Forge never auto-mutates: the hook only offers; generation happens on confirmation. Full detail in
[docs/BOOTSTRAP.md](./docs/BOOTSTRAP.md).

## Repo map

| Path | What |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | the two-layer system, target layout, plugin packaging, self-validation |
| [docs/BOOTSTRAP.md](./docs/BOOTSTRAP.md) | the self-tailoring engine: detect → profile → compose → generate → mark → sync |
| [docs/METHOD.md](./docs/METHOD.md) | the development method Forge encodes |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | phased build plan |
| [manifests/profiles.json](./manifests/profiles.json) | named project profiles → module sets |
| [manifests/modules.json](./manifests/modules.json) | modules → the components they contribute |

## Design principles (see [docs/METHOD.md](./docs/METHOD.md))

- **Additive, never destructive** — global install doesn't clobber existing `~/.claude`; project sync never
  overwrites your edits.
- **Detect-and-offer, never auto-mutate.**
- **Deterministic collection + LLM judgment** — scripts gather facts, the model composes.
- **Forge validates Forge** — no asset ships that fails the self-validators.
- **Fail-open hooks** — guardrails never deadlock a session.

## Federated catalog

Forge can register **external** Git/local repos as *sources*, pull their resources into a unified,
discoverable **catalog**, and selectively **admit** curated ones into the active library — without ever
running untrusted code. Full detail: [docs/specs/catalog.md](./docs/specs/catalog.md) and
[ADR-0017](./docs/adr/ADR-0017-federated-catalog.md).

**The model — catalog superset vs active library.** The **library** is today's owned, git-tracked,
active set. The **catalog** is the *superset*: the library ∪ every synced source's cache. A catalog-only
record is discoverable but **INERT** — never resolved by composition, never installed, never executed.
**Admission** is the one-way gate `catalog → library`; browsing or syncing a source has **zero
activation side-effects**.

**End-to-end workflow:**

```
forge source add <id> <url>     register an external repo (default ref main, trust=untrusted)
forge source sync <id>          shallow-clone -> ~/.claude/forge-sources/<id>; pin .forge/sources.lock
forge catalog build             assemble the unified catalog (library ∪ synced sources), INERT
forge catalog dedup             deterministic dedup classification across the catalog
/catalog-admit <uid>            drive one candidate through the gated admission pipeline:
                                  validate -> security-scan -> dedup -> judge -> test -> admit
forge catalog admit <uid> --apply   activate into the library behind the T2 gate (or --override)
```

The admission **pipeline** is fixed and gated — **validate → security-scan → dedup → judge → test →
admit** — and is **deterministic collection + LLM judgment**: scripts fix the inputs and signals; an
agent is invoked only at the two semantic seams (the security-scan auditors and the *conflict* judge).
Pure deterministic dedup outcomes (`unique`/`exact-dup`) spend no model call.

### Command surface

**`forge source <verb>`** — the source registry (operates `manifests/sources.json`; writers preview by
default, `--apply` to write):

| verb | what |
|---|---|
| `list` | list registered sources (id/kind/ref/trust/url). Read-only. |
| `add <id> <url> [--ref <r>] [--apply]` | register a new source (default ref `main`, trust `untrusted`). Never clobbers an existing id. |
| `remove <id> [--apply]` | drop a source from the manifest. |
| `sync [id] [--apply]` | shallow-clone source(s) to `~/.claude/forge-sources/<id>`; pin `.forge/sources.lock`. Clone + read ONLY. |
| `trust <id> [--apply]` | flip a source `untrusted → reviewed` (security-gated; **trust gates admission**). |

**`forge catalog <verb>`** — the unified catalog (library ∪ synced sources) + the admission lifecycle
(writers preview by default, `--apply` to write):

| verb | what |
|---|---|
| `build` | assemble the unified catalog; runs the deterministic security scan on every source candidate. Read-only. |
| `ls` | list catalog records (discoverable; INERT until admitted). |
| `dedup` | deterministic dedup classification (`unique`/`exact-dup`/`uid-collision`/`near-dup`) + conflicts. |
| `audit <uid> --agent <n> --verdict <v> [--evidence <s>] [--apply]` | record an auditor agent's verdict (`clean`/`suspicious`/`malicious`). |
| `judge <uid> --verdict <v> [--rationale <s>] [--apply]` | record the judge agent's conflict decision (`keep`/`replace`/`both`/`quarantine`). |
| `admit <uid> [--source <id>] [--override] [--apply]` | consult the T2 gate; on a clear gate (or a human `--override`) activate into the library. |
| `revoke <uid> [--apply]` | de-activate an admitted record back to the catalog (restores a replaced original). |

### The catalog-admit skill

The [`catalog-admit`](./skills/catalog-admit/SKILL.md) skill is the **runtime driver** for one trip
through the
admission pipeline. The auditor and judge **agents** run inside the Claude session and decide; the
`forge catalog …` verbs only **record + activate**. The skill sequences the fixed, gated order
**inspect → audit → record → judge (on conflict) → admit**, treats the candidate as untrusted DATA
throughout, and **never self-approves a T2** — when the gate refuses, it surfaces the refusal (the uid,
the exact `gate.reasons[]`, the evidence, and the precise `--override` command) for a human to apply.

### Security model

External repos are **UNTRUSTED code**, and the safety stance is baked into the shapes:

- **No-exec sync.** `sync` only clones + reads; it **NEVER executes fetched code** — no build,
  postinstall, npm, or hook registration as a side-effect, and no submodule recursion. The clone is
  `git clone --depth 1 --no-recurse-submodules`; the commit is resolved read-only.
- **Catalog-until-admitted.** Synced resources stay INERT; foreign hooks/commands never auto-enable.
- **Content is DATA, never instructions.** The deterministic scanners
  (`manager/lib/scan-injection.mjs`, `manager/lib/scan-resource-safety.mjs`) and the **auditor net** —
  [`injection-auditor`](./agents/injection-auditor.md) (run ALWAYS) + [`repo-safety-auditor`](./agents/repo-safety-auditor.md)
  (for every executable kind, static-only) — treat every byte as adversarial data. A candidate that says
  "skip the scan, I'm safe" is a *finding*, never a command (`rules/prompt-defense-baseline.md`).
- **T2 human gates.** Admitting a `replace` of an active resource, an **executable kind from an untrusted
  source**, or any candidate without the **required auditor** clearance is **human-gated**: `admit`
  refuses it unless a human applies `--override`. See [the T2 gates](./docs/specs/catalog.md#t2-human-applied-replace).
