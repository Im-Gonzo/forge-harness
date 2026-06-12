/**
 * Pure, dependency-free focus engine for the dependency graph. Given the flat
 * artifact list, it answers "what is connected to X, and how?" so the canvas
 * can spotlight a single node's neighborhood. No React, no side effects — every
 * function is deterministic and order-stable for the same input.
 *
 * Edge convention (mirrors dependency-graph.tsx buildFlow): an artifact's
 * `dependsOn` lists the uids it points AT (downstream). "module:" entries are
 * synthetic composition targets and are always ignored here.
 */
import type { RegistryArtifact } from "./types";

export type FocusDepth = 1 | 2 | "all";

/** A directed edge between two included uids (source dependsOn target). */
export interface FocusEdge {
  source: string;
  target: string;
}

export interface Neighborhood {
  /** Every uid in the neighborhood, including the focus node. */
  uids: Set<string>;
  /** dependsOn edges whose endpoints are both in `uids`. */
  edges: FocusEdge[];
}

/** True for synthetic composition targets that are never real graph nodes. */
function isModuleRef(uid: string): boolean {
  return uid.startsWith("module:");
}

/**
 * Build the reverse dependency index: uid → uids that list it in their
 * `dependsOn`. "module:" targets are ignored (they are not real nodes). Result
 * arrays follow the artifact iteration order, so output is deterministic.
 */
export function buildReverseIndex(
  artifacts: RegistryArtifact[],
): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  for (const a of artifacts) {
    for (const dep of a.dependsOn ?? []) {
      if (isModuleRef(dep)) continue;
      (reverse[dep] ??= []).push(a.uid);
    }
  }
  return reverse;
}

/**
 * BFS from `focusUid` out to `depth`, following dependencies (down, via
 * `dependsOn`) AND dependents (up, via the reverse index). The focus node is
 * always included. Returned edges only connect uids that made it into the set,
 * and "module:" targets are skipped. `depth` "all" expands until no new nodes.
 */
export function neighborhood(
  artifacts: RegistryArtifact[],
  focusUid: string,
  depth: FocusDepth,
  reverseIndex: Record<string, string[]>,
): Neighborhood {
  const byUid = new Map<string, RegistryArtifact>();
  for (const a of artifacts) byUid.set(a.uid, a);

  const uids = new Set<string>();
  // If the focus node doesn't exist, return an empty neighborhood.
  if (!byUid.has(focusUid)) return { uids, edges: [] };

  const maxDepth = depth === "all" ? Infinity : depth;

  // Level-synchronous BFS so a node's recorded distance is its shortest hop
  // count; visited tracks membership, `frontier` the current ring.
  uids.add(focusUid);
  let frontier: string[] = [focusUid];
  let dist = 0;
  while (frontier.length > 0 && dist < maxDepth) {
    const next: string[] = [];
    for (const uid of frontier) {
      const art = byUid.get(uid);
      // Downstream: this node's dependencies.
      for (const dep of art?.dependsOn ?? []) {
        if (isModuleRef(dep)) continue;
        if (!byUid.has(dep)) continue; // skip dangling/unknown targets
        if (!uids.has(dep)) {
          uids.add(dep);
          next.push(dep);
        }
      }
      // Upstream: nodes that depend on this node.
      for (const dependent of reverseIndex[uid] ?? []) {
        if (!byUid.has(dependent)) continue;
        if (!uids.has(dependent)) {
          uids.add(dependent);
          next.push(dependent);
        }
      }
    }
    frontier = next;
    dist += 1;
  }

  // Collect edges that live entirely inside the neighborhood. Iterating the
  // original artifact order keeps edge output stable.
  const edges: FocusEdge[] = [];
  for (const a of artifacts) {
    if (!uids.has(a.uid)) continue;
    for (const dep of a.dependsOn ?? []) {
      if (isModuleRef(dep)) continue;
      if (!uids.has(dep)) continue;
      edges.push({ source: a.uid, target: dep });
    }
  }

  return { uids, edges };
}
