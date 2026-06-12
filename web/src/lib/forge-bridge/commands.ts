/**
 * forge-bridge/commands — typed convenience wrappers over runForge for the
 * read-only commands the Phase-0 dashboards consume. Each returns the parsed
 * C3 envelope narrowed to the command's data payload.
 *
 * NOTE: server-only module. Import from server contexts only.
 */
import type {
  BridgeEnvelope,
  RegistryLsData,
  StatusData,
} from "@/lib/types";

import { runForge } from "./run";

/** `forge status --json` — the home dashboard payload. */
export function getStatus(): Promise<BridgeEnvelope<StatusData>> {
  return runForge<StatusData>("status");
}

/**
 * `forge registry build --json` (no --write) — the full artifact catalog,
 * COMPUTED LIVE from the active harness root. We use `build` (live scan), not
 * `ls` (which reads a cached `.forge/registry.json` that only the library has —
 * a freshly-scoped project has none, so `ls` would return 0). `build` without
 * `--write` computes the registry in-memory and persists nothing, so it works
 * for ANY scope (library or a project's `.claude/`) without mutating it.
 */
export function getRegistry(): Promise<BridgeEnvelope<RegistryLsData>> {
  return runForge<RegistryLsData>("registry", ["build"]);
}

/** `forge validate --json` — validation findings + summary. */
export function getValidation(): Promise<BridgeEnvelope> {
  return runForge("validate");
}
