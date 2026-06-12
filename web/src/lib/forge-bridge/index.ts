/**
 * forge-bridge — the ONLY module that touches forge.
 *
 * Two surfaces:
 *  1. CLI reads/writes via `runForge(cmd, args)` → parsed C3 envelope (run.ts),
 *     plus typed wrappers (commands.ts).
 *  2. On-disk resource read/list/write via readResource / listResources /
 *     writeResource (resources.ts). writeResource is the additive write path
 *     (write → validate → registry build).
 *
 * Everything here is server-only (node:child_process / node:fs). Import from
 * server components and route handlers, never from a "use client" boundary.
 */
export { runForge } from "./run";
export { getStatus, getRegistry, getValidation } from "./commands";
export {
  readResource,
  listResources,
  writeResource,
  relPathFor,
} from "./resources";

// Resource CRUD surface (additive — the per-resource editors' write path).
export {
  createResource,
  updateResource,
  deleteResource,
} from "./crud";
export type { CrudResult, ResourcePayload } from "./crud";

// Graph surface (additive — the /graph route's only forge touch-point).
export {
  getDangling,
  getOrphans,
  readManifest,
  readComposition,
  writeManifest,
  modifyManifestArray,
  deleteManifestProperty,
  editScalarArray,
  resolveDanglingRef,
} from "./graph";
export type {
  DanglingRef,
  DanglingSite,
  CompositionManifestName,
  ProfilesManifest,
  ModulesManifest,
  ModuleDef,
  ResolveDanglingPlan,
  ManifestWriteResult,
  JsonPath,
} from "./graph";

// Eval surface (additive — the /eval route's read of the append-only ledger).
export { readEvalLedger, groupLedgerByUid } from "./eval";
export type { EvalLedgerRecord } from "./eval";

// Memory-vault surface (additive — the /memory route's read of a memory vault
// + its index). `readProjectMemoryVault` is the PROJECT-SCOPED primary (the
// SELECTED PROJECT's `forge` memory, via the scoped CLI); `readMemoryVault` is
// the secondary global `~/.claude/memory-vault` read.
export {
  readMemoryVault,
  readProjectMemoryVault,
  DEFAULT_MEMORY_VAULT_DIR,
} from "./memory-vault";
export type { MemoryEntry, MemoryLink, MemoryVault } from "./memory-vault";

// Federated-source registry surface (additive — the /sources route's forge
// touch-point; `forge source <verb>` against the active root).
export {
  getSources,
  sourceAdd,
  sourceSync,
  sourceTrust,
  sourceRemove,
} from "./sources";

// Per-project slice-subscription surface (additive — the /api/slices route's
// forge touch-point; `forge slice <verb>` against the active root).
export { getSlices, sliceSubscribe, sliceUnsubscribe } from "./slices";

// Per-project composition (adopt) surface (additive — the /api/composition
// route's forge touch-point; `forge compose <verb>` against the active root).
export {
  getComposition,
  compositionAdopt,
  compositionRemove,
} from "./composition";

// Per-project conflicts & adjudication surface (additive — the /api/conflicts
// route's forge touch-point; `forge conflict <verb>` against the active root).
export {
  getConflicts,
  conflictResolve,
  conflictSetPolicy,
} from "./conflicts";

// Per-project tailoring & overlays surface (additive — the /api/tailoring
// route's forge touch-point; `forge tailor <verb>` against the active root).
export { getTailoring, tailorAdd, tailorRemove } from "./tailoring";

// Per-project lockfile surface (additive — the /api/lock route's forge
// touch-point; `forge lock <verb>` against the active root).
export { getLock, lockWrite, getLockDiff } from "./lock";

// Unified-catalog + admission surface (additive — the /catalog route's forge
// touch-point; `forge catalog <verb>` against the active root).
export {
  getCatalog,
  getCatalogDedup,
  catalogAudit,
  catalogJudge,
  catalogAdmit,
  catalogRevoke,
} from "./catalog";
