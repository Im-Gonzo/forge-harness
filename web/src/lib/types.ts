/**
 * Forge Web — shared types.
 *
 * Mirrors forge/schemas/*.json (the on-disk contracts) and the registry record.
 * The C3 envelope is the single machine-readable shape every `forge <cmd> --json`
 * command emits (schemas/envelope.schema.json); the unified finding is C2
 * (schemas/finding.schema.json). Resource-kind frontmatter shapes are derived
 * from the live resource files under FORGE_ROOT.
 */

// ──────────────────────────────────────────────────────────────────────────
// C2 — unified finding (schemas/finding.schema.json)
// ──────────────────────────────────────────────────────────────────────────

export type FindingLevel = "ERROR" | "WARN" | "INFO";

export interface Finding {
  /** Severity of the finding. */
  level: FindingLevel;
  /** Repo-relative path the finding concerns. */
  path: string;
  /** 1-based line, or null when not line-scoped. */
  line: number | null;
  /** Human-readable description. */
  message: string;
  /** Emitter — child validator filename or manager module noun. */
  source: string;
}

// ──────────────────────────────────────────────────────────────────────────
// C3 — the --json envelope (schemas/envelope.schema.json)
// ──────────────────────────────────────────────────────────────────────────

export interface EnvelopeSummary {
  /** Count of ERROR-level findings. */
  errors: number;
  /** Count of WARN-level findings. */
  warnings: number;
  /** Count of INFO-level findings. */
  info: number;
  /** Command-specific roll-up counts (e.g. validate's passed/failed). */
  [key: string]: number | undefined;
}

/**
 * The uniform machine-readable envelope. `data` is the only command-specific
 * part; `findings`/`summary` are uniform. Generic over the data payload.
 */
export interface Envelope<TData = Record<string, unknown>> {
  /** Raw VERSION the harness reported. */
  forge: string;
  /** The invoked command or command group. */
  command: string;
  /** Computed success: summary.errors === 0 and no failed child. */
  ok: boolean;
  /** ISO-8601 timestamp of when the envelope was produced. */
  ts: string;
  /** Command-specific payload. */
  data: TData;
  /** The uniform finding list (C2). */
  findings: Finding[];
  /** Roll-up counts. */
  summary: EnvelopeSummary;
}

/**
 * A locally-synthesized envelope returned by the bridge when the CLI could not
 * be spawned or its stdout could not be parsed (fail-soft path). `ok` is false
 * and the cause is surfaced as a single ERROR finding so the UI can render it
 * the same way as a real envelope.
 */
export type BridgeEnvelope<TData = Record<string, unknown>> = Envelope<TData> & {
  /** True when this envelope was synthesized by the bridge, not the CLI. */
  bridgeError?: boolean;
};

// ──────────────────────────────────────────────────────────────────────────
// Registry record (schemas/registry.schema.json)
// ──────────────────────────────────────────────────────────────────────────

export type ArtifactKind =
  | "agent"
  | "skill"
  | "command"
  | "rule"
  | "hook"
  | "bundle"
  | "validator"
  | "meta-test"
  | "engine";

export type ArtifactStatus =
  | "active"
  | "deprecated"
  | "experimental"
  | "planned";

export type ArtifactCriticality = "safety" | "compliance" | "normal";

/** One discovered harness artifact (registry.schema.json#/definitions/artifact). */
export interface RegistryArtifact {
  /** Stable key, "<kind>:<id>". */
  uid: string;
  kind: ArtifactKind;
  /** Kind-local identifier. */
  id: string;
  /** Repo-relative path; for hooks: "hooks/hooks.json#<id>". */
  path: string;
  /** Lowercase 64-hex sha256 of the artifact bytes. */
  contentHash: string;
  /** Monotonic revision counter. */
  revision: number;
  /** Semver intent. */
  version: string;
  status: ArtifactStatus;
  criticality: ArtifactCriticality;
  owner: string;
  description: string;
  tags: string[];
  /** Reverse-index of manifests/modules.json (module -> uid). */
  modules: string[];
  /** Dependency uids. */
  dependsOn: string[];
  /** Eval-linkage slot; payload owned by Bundle E. */
  eval: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** The generated registry snapshot (forge/.forge/registry.json). */
export interface RegistrySnapshot {
  schemaVersion: number;
  VERSION: string;
  generatedAt: string;
  artifacts: RegistryArtifact[];
  danglingRefs?: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Command-data shapes (subset used by Phase 0 — `forge status`)
// ──────────────────────────────────────────────────────────────────────────

export interface StatusPanelBase {
  panel: string;
  /** true=ok, false=problem, null=no-data/off. */
  ok: boolean | null;
  lines?: string[];
  state?: string;
  hint?: string;
  data?: Record<string, unknown>;
}

export interface RegistryPanel extends StatusPanelBase {
  panel: "registry";
  data: {
    artifacts: number;
    stale: number;
    byKind: Partial<Record<ArtifactKind, number>>;
  };
}

export interface DependencyPanel extends StatusPanelBase {
  panel: "dependency";
  data: { dangling: number; orphans: number };
}

export interface FleetPanel extends StatusPanelBase {
  panel: "fleet";
  data: {
    projects: number;
    grades: { healthy: number; drift: number; unhealthy: number };
  };
}

export interface TelemetryPanel extends StatusPanelBase {
  panel: "telemetry";
}

export interface EfficiencyPanel extends StatusPanelBase {
  panel: "efficiency";
}

export interface EvalPanel extends StatusPanelBase {
  panel: "eval";
}

export interface StatusData {
  panels: {
    registry: RegistryPanel;
    dependency: DependencyPanel;
    fleet: FleetPanel;
    telemetry: TelemetryPanel;
    efficiency: EfficiencyPanel;
    eval: EvalPanel;
  };
  panelOrder: string[];
  nextActions: string[];
}

export interface RegistryLsData {
  artifacts: RegistryArtifact[];
}

// ──────────────────────────────────────────────────────────────────────────
// Federated catalog — sources (manifests/sources.json, schemas/sources.schema.json)
// ──────────────────────────────────────────────────────────────────────────

/** Source kind: a remote git repo, or a local filesystem path. */
export type SourceKind = "git" | "local";

/**
 * Trust level of a registered source. Every new source starts "untrusted";
 * `forge source trust <id>` promotes it to "reviewed" (trust gates admission).
 * The list verb defaults absent values to "" (fail-open), so allow the empty form.
 */
export type SourceTrust = "untrusted" | "reviewed" | "";

/**
 * One registered federated source as `forge source list --json` enumerates it
 * (data.sources[]). Mirrors source.mjs#doList's projection of sources.json —
 * each string field defaults to "" when absent in the manifest (fail-open).
 */
export interface SourceRecord {
  /** Stable source id (the cache dir name + lockfile key). */
  id: string;
  /** Clone URL (git) or filesystem path (local) of the source repo. */
  url: string;
  /** Branch/tag/commit the source tracks (default "main"). */
  ref: string;
  /** Source kind. "" when absent in a malformed manifest. */
  kind: SourceKind | "";
  /** ISO-8601 timestamp the source was registered, or "". */
  addedAt: string;
  /** Trust level (untrusted | reviewed | ""). */
  trust: SourceTrust;
}

/** `forge source list --json` data payload. */
export interface SourceListData {
  /** Absolute path of manifests/sources.json. */
  manifestPath: string;
  /** Registered sources, one record per id. */
  sources: SourceRecord[];
}

// ──────────────────────────────────────────────────────────────────────────
// Federated catalog — slices & subscriptions (forge slice list, ADR-0018)
// ──────────────────────────────────────────────────────────────────────────

/**
 * One SLICE = a named group of ONE source's catalog records, grouped by registry
 * kind. id is "<sourceId>/<kind>" (forward slash; resource uids use "<kind>:<id>",
 * so "/" avoids ambiguity). Mirrors slices.mjs#doList's per-(source, kind)
 * projection. `subscribed` is true iff `id` is in .forge/subscriptions.json.
 */
export interface SliceRecord {
  /** "<sourceId>/<kind>" — the stable slice id (the subscriptions.json key). */
  id: string;
  /** Singular registry kind (agent | skill | command | …). */
  kind: string;
  /** Display name == kind. */
  name: string;
  /** # of that source's catalog records of that kind. */
  count: number;
  /** True iff the active project opted into this slice. */
  subscribed: boolean;
}

/** `forge slice list --json` data payload. */
export interface SliceListData {
  /** Absolute path of .forge/subscriptions.json under the ACTIVE project root. */
  subscriptionsPath: string;
  /** One entry per source that has >=1 source record, sorted by sourceId. */
  sources: {
    /** The source id (manifests/sources.json#sources[].id). */
    sourceId: string;
    /** This source's slices, one per (sourceId, kind), sorted by kind. */
    slices: SliceRecord[];
  }[];
}

// ──────────────────────────────────────────────────────────────────────────
// Composition — per-project adopted resources (forge compose list, ADR-0019)
// ──────────────────────────────────────────────────────────────────────────

/**
 * One ADOPTED resource in the per-project COMPOSITION. An adopted entry is keyed
 * by (uid, sourceId); sourceId===null means the library-local copy. The kind /
 * version / criticality are RESOLVED by joining the on-disk composition entry to
 * its catalog record at list time (compose.mjs#doList), so they reflect the live
 * read-view, not stored state. Mirrors `forge compose list --json` data.adopted[].
 */
export interface CompositionEntry {
  /** Stable resource key, "<kind>:<id>". */
  uid: string;
  /** Singular registry kind resolved from the catalog record (agent | skill | …). */
  kind: string;
  /** Source id the copy was adopted from; null = the library-local copy. */
  sourceId: string | null;
  /** Semver from the resolved record; "" when absent. */
  version: string;
  /** Criticality from the resolved record (safety | compliance | normal); "" when absent. */
  criticality: string;
}

/** `forge compose list --json` data payload. */
export interface CompositionData {
  /** Absolute path of .forge/composition.json under the ACTIVE project root. */
  compositionPath: string;
  /**
   * Adopted entries, sorted deterministically (by uid then sourceId, null first).
   * Orphaned entries whose resource left the read-view are DROPPED from this array
   * (reported as a WARN finding), never deleted from disk.
   */
  adopted: CompositionEntry[];
  /** Roll-up counts. */
  counts: {
    /** adopted.length. */
    adopted: number;
    /** Count of distinct non-null sourceIds. */
    sources: number;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Conflicts & adjudication — per-project conflict set (forge conflict list, ADR-0020)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-criticality adjudication policy: each criticality (ADR-0013) maps to "auto"
 * (the conflict is adopted at composition level without an explicit per-conflict
 * pick) or "block" (explicit human adjudication required). DEFAULT is all-"block"
 * (conservative). A `resolve` that REPLACES an already-admitted library resource
 * stays a T2 human action even under "auto" (BR-CAT-003). Mirrors the CLI's
 * .forge/adjudication.json#policy.
 */
export interface AdjudicationPolicy {
  normal: "auto" | "block";
  compliance: "auto" | "block";
  safety: "auto" | "block";
}

/**
 * One CANDIDATE record of a conflict — a DISTINCT read-view record (by sourceId)
 * for the conflicted uid. `sourceId === null` is the library-local copy. `score` is
 * a REAL eval score or null (the UI shows "—"); NEVER fabricated. `metrics` is []
 * when none. `security` is the scan state ("clean" | "flagged" | "quarantined" |
 * "pending" | ""). Mirrors `forge conflict list --json` data.conflicts[].candidates[].
 */
export interface ConflictCandidate {
  /** Source id the candidate came from; null = the library-local copy. */
  sourceId: string | null;
  /** Semver from the resolved record; "" when absent. */
  version: string;
  /** REAL eval score, or null when no score exists (UI renders "—"). */
  score: number | null;
  /** Display metric pairs; [] when none. */
  metrics: { k: string; v: string }[];
  /** Security-scan state of the candidate. "" when unknown. */
  security: string;
}

/**
 * One CONFLICT = a uid with >= 2 distinct candidate records in the read-view
 * (dedup uid-collision / near-dup). `judge` is the recorded sidecar verdict for this
 * uid (CONSUMED, never produced here) or null. `suggested` is a HINT — the
 * eval-highest candidate's sourceId, else the recorded judge winner, else null
 * ("needs human"). `choice` is the recorded human pick sourceId (null = library or
 * unresolved — disambiguated by `state`). `state`: choice!=null -> "manual";
 * policy[criticality]=="auto" -> "auto"; else "blocking". Mirrors
 * `forge conflict list --json` data.conflicts[].
 */
export interface ConflictRecord {
  /** Stable resource key, "<kind>:<id>" (ADR-0005). */
  uid: string;
  /** Singular registry kind (agent | skill | …). */
  kind: string;
  /** Criticality keying the policy (safety | compliance | normal). */
  criticality: "normal" | "compliance" | "safety";
  /** The >= 2 distinct candidate records (by sourceId). */
  candidates: ConflictCandidate[];
  /** The recorded judge verdict for this uid (CONSUMED from the sidecar), or null. */
  judge: { verdict: string; winner: string | null; rationale: string } | null;
  /** Hint: eval-highest sourceId -> recorded judge winner -> null ("needs human"). */
  suggested: string | null;
  /** Recorded human pick sourceId (null = library copy, or unresolved per `state`). */
  choice: string | null;
  /** choice!=null -> "manual"; policy[criticality]=="auto" -> "auto"; else "blocking". */
  state: "manual" | "auto" | "blocking";
}

/** `forge conflict list --json` data payload. */
export interface ConflictsData {
  /** Absolute path of .forge/adjudication.json under the ACTIVE project root. */
  adjudicationPath: string;
  /** The per-criticality adjudication policy (default all-"block"). */
  policy: AdjudicationPolicy;
  /** The derived read-view conflicts (uid-collision / near-dup), each with candidates. */
  conflicts: ConflictRecord[];
  /** Roll-up counts. */
  counts: {
    /** conflicts.length. */
    total: number;
    /** Count with state === "blocking". */
    blocking: number;
    /** Count with state === "auto". */
    auto: number;
    /** Count with state === "manual". */
    manual: number;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tailoring & overlays — per-adopted-resource modifiers (forge tailor list, ADR-0021)
// ──────────────────────────────────────────────────────────────────────────

/**
 * One TAILORING OVERLAY = a per-adopted-resource modifier. `type` is one of
 * pin | override | layer | gate | fork | disable; `detail` is a short string
 * whose meaning is type-specific (a version for pin, "field → value" for
 * override, the gate condition for gate, a fragment note for layer, optional
 * for fork/disable). Overlays are RECORDED INTENTIONS — they are never applied
 * to real .claude/ files here (that is Slice 5). Mirrors the CLI overlay shape.
 */
export interface Overlay {
  /** pin | override | layer | gate | fork | disable. */
  type: string;
  /** Type-specific short detail; may be "" for fork/disable. */
  detail: string;
}

/**
 * The deterministic, display-only RESOLVED PREVIEW of an adopted resource after
 * folding its overlays over the base catalog record. It is a VIEW — never the
 * library, never any on-disk file. Mirrors `forge tailor list --json`
 * data.tailored[].resolved.
 */
export interface ResolvedPreview {
  /** Base "sonnet"; an override "model → X" sets it. */
  model: string;
  /** Base residency (e.g. "conditional"). */
  residency: string;
  /** Base "default"; a gate sets it to the gate detail. */
  activation: string;
  /** Base "source"; fork -> "forked · local edits"; layer -> "source + project layer". */
  body: string;
  /** Base "active"; disable -> "disabled". */
  status: string;
  /** Base from the record; a pin sets it. */
  version: string;
}

/**
 * One TAILORED entry = an adopted resource carrying >= 1 overlay. `kind` and the
 * `resolved` base values are JOINed from the catalog record at list time, so they
 * reflect the live read-view, not stored state. `sourceId === null` means the
 * library-local copy. Orphaned entries (no longer adopted) are DROPPED from the
 * array (reported as a WARN), never deleted from disk. Mirrors
 * `forge tailor list --json` data.tailored[].
 */
export interface TailoredEntry {
  /** Stable resource key, "<kind>:<id>". */
  uid: string;
  /** Source id the copy was adopted from; null = the library-local copy. */
  sourceId: string | null;
  /** Singular registry kind JOINed from the composition/catalog record. */
  kind: string;
  /** This resource's overlays, deterministically sorted by (type, detail). */
  overlays: Overlay[];
  /** The deterministic display-only resolved preview (fold over the base record). */
  resolved: ResolvedPreview;
}

/** `forge tailor list --json` data payload. */
export interface TailoringData {
  /** Absolute path of .forge/tailoring.json under the ACTIVE root. */
  tailoringPath: string;
  /**
   * Tailored entries joined to their catalog record. Orphaned entries whose
   * resource is no longer adopted are DROPPED here (WARN finding), retained on disk.
   */
  tailored: TailoredEntry[];
  /** Roll-up counts. */
  counts: {
    /** tailored.length. */
    tailored: number;
    /** Total overlays across all tailored entries. */
    overlays: number;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-project lockfile — the resolved composition manifest (forge lock, ADR-0022)
// ──────────────────────────────────────────────────────────────────────────

/**
 * One resolved entry in forge.lock = an adopted (uid, sourceId) pair JOINed with
 * its pinned version/commit, its tailoring overlays, and the adjudication winner
 * for the uid. `sourceId === null` is the library-local copy; `commit === null`
 * for a library-local entry or an unpinned source; `adjudication` is the recorded
 * winner sourceId for the uid (else null). Overlays are reduced to {type, detail}
 * and sorted deterministically. Mirrors lock.mjs#resolveEntries' entry shape
 * (`forge lock write --json` data.lock.entries[]).
 */
export interface LockEntry {
  /** Stable resource key, "<kind>:<id>". */
  uid: string;
  /** Source id the copy was adopted from; null = the library-local copy. */
  sourceId: string | null;
  /** Singular registry kind resolved from the catalog record (agent | skill | …). */
  kind: string;
  /** Resolved semver (a pin overlay wins, else the catalog record version); null when absent. */
  version: string | null;
  /** Pinned source commit (.forge/sources.lock); null for library-local or unpinned. */
  commit: string | null;
  /** This entry's overlays, deterministically sorted by (type, detail). */
  overlays: Overlay[];
  /** Recorded adjudication winner sourceId for the uid, or null. */
  adjudication: string | null;
}

/**
 * The forge.lock manifest contents (schema "forge.lock.v1"). The `hash` is a
 * deterministic sha256 digest (first 16 hex) over the CANONICAL entries —
 * EXCLUDING `generatedAt` — so the same composition yields the same hash across
 * machines and times. `generatedAt` is recorded for humans only. Mirrors
 * lock.mjs#buildLock.
 */
export interface LockData {
  /** On-disk schema tag ("forge.lock.v1"). */
  schema: string;
  /** Lock schema version integer. */
  version: number;
  /** ISO-8601 timestamp the lock was generated (humans only; never feeds the hash). */
  generatedAt: string;
  /** Deterministic content hash over the canonical entries (excludes generatedAt). */
  hash: string;
  /** The resolved entries, sorted by (uid, sourceId). */
  entries: LockEntry[];
}

/**
 * `forge lock show --json` data payload. `lock` is the parsed forge.lock contents,
 * or null when the file is absent or malformed. `committed` is a best-effort
 * "is forge.lock git-tracked?" signal; `inSync` is true when the file's hash equals
 * a freshly-resolved hash (the composition has not drifted since the lock was written).
 * Mirrors lock.mjs#doShow.
 */
export interface LockShowData {
  /** Absolute path of forge.lock under the ACTIVE project root. */
  lockPath: string;
  /** True when forge.lock exists on disk (and is a JSON object). */
  exists: boolean;
  /** Parsed forge.lock contents, or null when absent/malformed. */
  lock: LockData | null;
  /** Best-effort: is forge.lock tracked by git? */
  committed: boolean;
  /** True when the file's hash === the freshly-resolved hash (composition unchanged). */
  inSync: boolean;
}

/**
 * One per-entry change between the CURRENT forge.lock and the freshly-resolved
 * composition. `op` is "+" (newly resolved, not in the lock), "-" (in the lock but
 * no longer resolved), or "~" (version/overlay/adjudication/commit changed).
 * `from`/`to` carry compact field summaries on a "~" change; `note` is a human
 * description. Mirrors lock.mjs#doDiff data.changes[].
 */
export interface LockDiffChange {
  /** "~" = changed | "+" = added | "-" = removed. */
  op: "~" | "+" | "-";
  /** Stable resource key, "<kind>:<id>". */
  uid: string;
  /** Source id; null = the library-local copy. */
  sourceId: string | null;
  /** Compact summary of the prior entry's resolved fields (present on "~"). */
  from?: {
    version: string | null;
    commit: string | null;
    overlays: string[];
    adjudication: string | null;
  };
  /** Compact summary of the fresh entry's resolved fields (present on "~"). */
  to?: {
    version: string | null;
    commit: string | null;
    overlays: string[];
    adjudication: string | null;
  };
  /** Human-readable description of the change. */
  note?: string;
}

/**
 * `forge lock diff --json` data payload — the changes between the CURRENT
 * forge.lock and the freshly-resolved composition, plus the comparison hashes and
 * an `inSync` flag (the file's hash equals the freshly-resolved hash). Mirrors
 * lock.mjs#doDiff.
 */
export interface LockDiffData {
  /** Per-entry changes (empty when in sync). */
  changes: LockDiffChange[];
  /** Roll-up counts. */
  summary: {
    /** changes.length. */
    total: number;
    /** Count with op === "+". */
    added: number;
    /** Count with op === "-". */
    removed: number;
    /** Count with op === "~". */
    changed: number;
  };
  /** The freshly-resolved hash. */
  hash: string;
  /** The current forge.lock's hash, or null when absent/malformed. */
  priorHash: string | null;
  /** True when priorHash === hash (the lock is in sync with the composition). */
  inSync: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Federated catalog — records (forge catalog build|dedup, ADR-0017)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Federated provenance attached to a SOURCE-synced catalog record; null for an
 * owned/library-local record. Mirrors catalog.mjs#makeProvenance.
 */
export interface CatalogSourceProvenance {
  /** The source id this record came from (manifests/sources.json#sources[].id). */
  sourceId: string;
  /** Clone URL (git) or filesystem path (local) of the source. */
  repoUrl: string;
  /** Branch/tag/commit the source tracks. */
  ref: string;
  /** Exact upstream commit the bytes were synced from (.forge/sources.lock). "" when unpinned. */
  commit: string;
  /** ISO-8601 timestamp the record entered the catalog. "" when unsynced. */
  importedAt: string;
  /** The SOURCE's trust level at build time ('untrusted' | 'reviewed' | ''). */
  trust: SourceTrust;
}

/** One deterministic security-scan finding (layer 1 scanners). */
export interface CatalogScanFinding {
  rule?: string;
  severity?: string;
  path?: string;
  line?: number | null;
  evidence?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Layer-1 deterministic scanner results — a LIGHTWEIGHT SUMMARY (F11 scaling fix).
 *
 * The CLI does NOT embed every finding per record in the list payload: on a real source
 * the scanners can emit hundreds of thousands of findings (a real-world source: 656,329 → ~189 MB), which
 * the bridge can't accumulate/parse. So the list carries COUNTS (high/medium drive the
 * flagged/clean classification + the admit gate) plus a small representative `sample`.
 * The headline `scan` state is computed over the FULL findings CLI-side before
 * summarizing, so classification is unchanged — only the payload shrinks. See
 * manager/catalog.mjs#summarizeDeterministic.
 */
export interface CatalogDeterministicScan {
  /** Total number of deterministic findings the scanners produced. */
  findingCount: number;
  /** Count of high-severity findings (drives flagged + the admit gate). */
  high: number;
  /** Count of medium-severity findings (also drives flagged). */
  medium: number;
  /** The FIRST few findings verbatim (preview, not the whole set). Empty when clean. */
  sample: CatalogScanFinding[];
}

/** One layer-2 auditor AGENT verdict (recorded via `catalog audit`). */
export interface CatalogAuditorVerdict {
  /** Auditor agent id (e.g. 'injection-auditor', 'repo-safety-auditor'). */
  agent: string;
  /** Semantic verdict. */
  verdict: "clean" | "suspicious" | "malicious";
  /** Quoted file:line evidence backing the verdict. */
  evidence: string[];
  /** ISO-8601 timestamp the verdict was recorded (sidecar). */
  recordedAt?: string;
}

/** Overall security-scan gate state (ADR-0017 §5a). */
export type CatalogScanState = "pending" | "clean" | "flagged" | "quarantined";

/** The security-scan gate slot of a catalog record. */
export interface CatalogSecurity {
  /** Overall scan state. Library records stay "pending" (never scanned). */
  scan: CatalogScanState;
  /** Layer-1 deterministic scanner results. */
  deterministic: CatalogDeterministicScan;
  /** Layer-2 auditor agent verdicts. Empty when none ran. */
  auditors: CatalogAuditorVerdict[];
  /** Set ONLY by a deliberate human T2 action; the pipeline never sets it. */
  humanOverride: boolean;
}

/** Deterministic dedup classification of a record vs. the rest of the catalog. */
export type CatalogDedupClass =
  | "unique"
  | "exact-dup"
  | "uid-collision"
  | "near-dup";

/** Dedup verdict slot (deterministic; overwritten by `catalog dedup`). */
export interface CatalogDedupVerdict {
  /** The highest-precedence relation this record has with any peer. */
  class: CatalogDedupClass;
  /** uids of the peer record(s) this verdict refers to. */
  peers: string[];
}

/** Judge AGENT verdict slot, populated ONLY on a conflict; null otherwise. */
export interface CatalogJudgeVerdict {
  /** The judge's decision. */
  verdict: "keep" | "replace" | "both" | "quarantine";
  /** Short human-readable rationale. */
  rationale: string;
  /** ISO-8601 timestamp the verdict was recorded (sidecar). */
  recordedAt?: string;
}

/** Where a record sits in the catalog→library lifecycle. */
export type CatalogAdmissionState = "catalog" | "admitted" | "quarantined";

/**
 * One catalog record = a registry ARTIFACT (RegistryArtifact fields verbatim) +
 * federated `source` provenance + an `admissionState` + the security/dedup/judge
 * verdict slots. The contract `forge catalog build|dedup` emits in data.records[].
 * Mirrors catalog.mjs#CatalogRecord (the build-agent contract).
 */
export interface CatalogRecord extends RegistryArtifact {
  /** Federated provenance; null for an owned/library-local record. */
  source: CatalogSourceProvenance | null;
  /** catalog (inert) | admitted (active library) | quarantined (flagged/held). */
  admissionState: CatalogAdmissionState;
  /** Security-scan gate slot (ADR-0017 §5a). */
  security: CatalogSecurity;
  /** Dedup classification slot (deterministic). */
  dedup: CatalogDedupVerdict;
  /** Agent conflict verdict; null until a conflict is resolved/recorded. */
  judge: CatalogJudgeVerdict | null;
}

/** `forge catalog build --json` data payload. */
export interface CatalogBuildData {
  /** On-disk schema tag ("forge.catalog.v1"). */
  schema: string;
  /** Unified catalog: library ∪ synced sources, each a CatalogRecord. */
  records: CatalogRecord[];
}

/** One unresolved dedup conflict (uid-collision | near-dup) from `catalog dedup`. */
export interface CatalogDedupConflict {
  uid: string;
  class: CatalogDedupClass;
  peers: string[];
}

/** Per-class record counts emitted by `catalog dedup` (data.counts). */
export interface CatalogDedupCounts {
  unique: number;
  "exact-dup": number;
  "uid-collision": number;
  "near-dup": number;
}

/** `forge catalog dedup --json` data payload (build records + counts + conflicts). */
export interface CatalogDedupData {
  /** On-disk schema tag ("forge.catalog.v1"). */
  schema: string;
  /** The classified catalog (each record.dedup populated). */
  records: CatalogRecord[];
  /** Per-class record counts. */
  counts: CatalogDedupCounts;
  /** The unresolved conflicts held for the judge/T2 gate during admit. */
  conflicts: CatalogDedupConflict[];
}

// ──────────────────────────────────────────────────────────────────────────
// Resource kinds (on-disk frontmatter + body)
// ──────────────────────────────────────────────────────────────────────────

/** The editable resource kinds Forge Web manages on disk. */
export type ResourceKind =
  | "agent"
  | "skill"
  | "command"
  | "rule"
  | "bundle"
  | "memory"
  | "hook"
  | "workflow"
  | "mcp";

/** A resource as read from disk: parsed frontmatter + markdown/body + path. */
export interface ResourceFile<TFrontmatter = Record<string, unknown>> {
  /** Parsed YAML frontmatter (gray-matter `data`). */
  frontmatter: TFrontmatter;
  /** The markdown body after the frontmatter (gray-matter `content`). */
  body: string;
  /** Absolute path on disk. */
  path: string;
  /** Repo-relative path (relative to FORGE_ROOT). */
  relPath: string;
  /** Kind-local id used to address this resource. */
  id: string;
  kind: ResourceKind;
}

/** Lightweight listing entry (no body) returned by listResources(). */
export interface ResourceListEntry<TFrontmatter = Record<string, unknown>> {
  id: string;
  kind: ResourceKind;
  path: string;
  relPath: string;
  frontmatter: TFrontmatter;
}

// Agent frontmatter (agents/*.md)
export interface AgentFrontmatter {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  [key: string]: unknown;
}

// Skill frontmatter (skills/<id>/SKILL.md)
export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

// Command frontmatter (commands/*.md)
export interface CommandFrontmatter {
  description: string;
  "argument-hint"?: string;
  "allowed-tools"?: string;
  [key: string]: unknown;
}

// Rule frontmatter (rules/**.md)
export interface RuleFrontmatter {
  name: string;
  description: string;
  /** Glob scope; absent = always-on. */
  paths?: string[];
  [key: string]: unknown;
}

// Bundle frontmatter (bundles/*.md) — 16-field structured form (bundle.schema.json)
export interface BundleAdrPointer {
  id: string;
  path: string;
  why?: string;
}
export interface BundleSpecSection {
  path: string;
  sections: string[];
}
export interface BundleFrontmatter {
  id: string;
  title: string;
  version: number;
  status: string;
  work_type: string;
  invariants: number[];
  adrs: BundleAdrPointer[];
  spec_sections: BundleSpecSection[];
  br_ids: string[];
  conformance: string[];
  modules: string[];
  skill: string;
  secondary_skill?: string;
  agent: string;
  reviewer?: string;
  additional_reviewers?: string[];
  dod_ref: string;
  invisible_20: unknown[];
  human_gate: boolean;
  backlog_slices?: unknown[];
  acceptance_gates?: unknown[];
  release_blocking_gates?: unknown[];
  [key: string]: unknown;
}

// Workflow frontmatter (workflows/*.md) — a named multi-phase workflow
export interface WorkflowFrontmatter {
  name: string;
  description: string;
  /** Optional ordered phase names. */
  phases?: string[];
  [key: string]: unknown;
}

// Memory frontmatter (memory/*.md) — confidence-scored vault note
export interface MemoryFrontmatter {
  /** Confidence 0–1. */
  confidence?: number;
  [key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// Hooks (hooks/hooks.json — schemas/hooks.schema.json)
// ──────────────────────────────────────────────────────────────────────────

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
}

export interface HookMatcherGroup {
  matcher?: string;
  description?: string;
  id?: string;
  hooks: HookCommand[];
}

export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "UserPromptSubmit";

export type HookEventMap = Partial<Record<HookEvent, HookMatcherGroup[]>>;

/** hooks/hooks.json — event map may be nested under a top-level "hooks" key. */
export interface HooksFile {
  $schema?: string;
  hooks?: HookEventMap;
}

// ──────────────────────────────────────────────────────────────────────────
// Write-path result
// ──────────────────────────────────────────────────────────────────────────

export interface WriteResult {
  /** Overall success — the file was written and validate reported no ERRORs. */
  ok: boolean;
  /** Absolute path that was written. */
  path: string;
  /** Findings surfaced by `forge validate` (advisory WARNs included, never thrown). */
  findings: Finding[];
  /** The full `forge validate --json` envelope. */
  validateResult: BridgeEnvelope;
  /** The `forge registry build --write` envelope. */
  registryResult: BridgeEnvelope;
}
