/**
 * Pure, dependency-free engine for the memory wiki-link graph. Mirrors
 * graph/focus-engine.ts + graph/layout.ts but over MemoryLink edges (entry
 * id → entry id). No React, no side effects — every function is deterministic
 * and order-stable for the same input.
 *
 * Edge convention: a MemoryLink {source, target, resolved}. RESOLVED links
 * connect two known entry ids; UNRESOLVED links point at a raw target string
 * that is NOT an entry (a dangling wiki-link → rendered as a red ghost node).
 */
import type { MemoryEntry, MemoryLink } from "@/lib/forge-bridge";

export type FocusDepth = 1 | 2 | "all";

/** Synthetic node id for a dangling (unresolved) wiki-link target. */
export function ghostId(rawTarget: string): string {
  return `ghost:${rawTarget}`;
}

/** Forward index: entry id → resolved entry ids it links OUT to. */
export function buildForwardIndex(
  links: MemoryLink[],
): Record<string, string[]> {
  const fwd: Record<string, string[]> = {};
  for (const l of links) {
    if (!l.resolved) continue;
    (fwd[l.source] ??= []).push(l.target);
  }
  return fwd;
}

/** Reverse index: entry id → resolved entry ids that link IN to it (backlinks). */
export function buildReverseIndex(
  links: MemoryLink[],
): Record<string, string[]> {
  const rev: Record<string, string[]> = {};
  for (const l of links) {
    if (!l.resolved) continue;
    (rev[l.target] ??= []).push(l.source);
  }
  return rev;
}

/**
 * Degree (in + out) per entry id, counting only RESOLVED links. Drives node
 * sizing — hubs (high degree) render larger. Unresolved links don't count
 * toward an entry's degree (their target isn't a real node).
 */
export function buildDegrees(links: MemoryLink[]): Map<string, number> {
  const deg = new Map<string, number>();
  const bump = (id: string) => deg.set(id, (deg.get(id) ?? 0) + 1);
  for (const l of links) {
    if (!l.resolved) continue;
    bump(l.source);
    bump(l.target);
  }
  return deg;
}

/**
 * Entry ids with zero in AND out resolved links → orphans. Unresolved links
 * still count as an OUTBOUND link for orphan purposes (the entry does reach
 * out, even if the target is missing), so an entry whose only links are
 * dangling is NOT an orphan.
 */
export function findOrphans(
  entries: MemoryEntry[],
  links: MemoryLink[],
): string[] {
  const linked = new Set<string>();
  for (const l of links) {
    linked.add(l.source); // any outbound link (resolved or not)
    if (l.resolved) linked.add(l.target); // only resolved inbound
  }
  return entries.filter((e) => !linked.has(e.id)).map((e) => e.id);
}

export interface MemoryNeighborhood {
  /** Known entry ids in the neighborhood, including the focus entry. */
  ids: Set<string>;
  /** Resolved edges with both endpoints inside `ids`. */
  edges: { source: string; target: string }[];
  /** Unresolved (dangling) edges from any included entry → raw target. */
  ghosts: { source: string; rawTarget: string }[];
}

/**
 * BFS from `focusId` out to `depth`, following both forward (outbound) and
 * reverse (backlink) resolved links. The focus entry is always included.
 * Returned edges only connect ids in the set; dangling links FROM any included
 * entry are surfaced separately as ghosts so the canvas can draw red targets.
 * `depth` "all" expands until no new nodes.
 */
export function neighborhood(
  entries: MemoryEntry[],
  links: MemoryLink[],
  focusId: string,
  depth: FocusDepth,
  forwardIndex: Record<string, string[]>,
  reverseIndex: Record<string, string[]>,
): MemoryNeighborhood {
  const known = new Set(entries.map((e) => e.id));
  const ids = new Set<string>();
  if (!known.has(focusId)) return { ids, edges: [], ghosts: [] };

  const maxDepth = depth === "all" ? Infinity : depth;

  ids.add(focusId);
  let frontier: string[] = [focusId];
  let dist = 0;
  while (frontier.length > 0 && dist < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const out of forwardIndex[id] ?? []) {
        if (!ids.has(out)) {
          ids.add(out);
          next.push(out);
        }
      }
      for (const inc of reverseIndex[id] ?? []) {
        if (!ids.has(inc)) {
          ids.add(inc);
          next.push(inc);
        }
      }
    }
    frontier = next;
    dist += 1;
  }

  // Resolved edges fully inside the neighborhood (stable: links order).
  const edges: { source: string; target: string }[] = [];
  const ghosts: { source: string; rawTarget: string }[] = [];
  for (const l of links) {
    if (!ids.has(l.source)) continue;
    if (l.resolved) {
      if (ids.has(l.target)) edges.push({ source: l.source, target: l.target });
    } else {
      ghosts.push({ source: l.source, rawTarget: l.target });
    }
  }

  return { ids, edges, ghosts };
}

/**
 * Radial focus layout. The focus entry sits at the origin; everything else is
 * placed in concentric rings by BFS hop distance. Within a ring, pure
 * backlinks (only reachable upstream) fan LEFT, pure outbound (only reachable
 * downstream) fan RIGHT, both-direction nodes sit right. Adapted from
 * graph/layout.ts layoutRadial. Deterministic for the same input.
 */
export function layoutRadial(
  focusId: string,
  ids: Set<string>,
  entries: MemoryEntry[],
  forwardIndex: Record<string, string[]>,
  reverseIndex: Record<string, string[]>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (!ids.has(focusId)) return positions;

  const ringGap = 300;
  const rowGap = 76;

  // Stable iteration order = entries order.
  const ordered = entries.filter((e) => ids.has(e.id)).map((e) => e.id);

  const dist = new Map<string, number>();
  const sideHits = new Map<string, Set<number>>();
  const noteSide = (id: string, side: number) => {
    (sideHits.get(id) ?? sideHits.set(id, new Set()).get(id)!).add(side);
  };

  dist.set(focusId, 0);
  let frontier: string[] = [focusId];
  let d = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      // Outbound → right (+1).
      for (const out of forwardIndex[id] ?? []) {
        if (!ids.has(out)) continue;
        if (!dist.has(out)) {
          dist.set(out, d + 1);
          next.push(out);
        }
        if (out !== focusId) noteSide(out, 1);
      }
      // Backlinks → left (-1).
      for (const inc of reverseIndex[id] ?? []) {
        if (!ids.has(inc)) continue;
        if (!dist.has(inc)) {
          dist.set(inc, d + 1);
          next.push(inc);
        }
        if (inc !== focusId) noteSide(inc, -1);
      }
    }
    frontier = next;
    d += 1;
  }

  const buckets = new Map<string, string[]>(); // `${side}:${ring}`
  for (const id of ordered) {
    if (id === focusId) continue;
    const ring = dist.get(id) ?? 1;
    const sides = sideHits.get(id);
    const side = sides && sides.has(1) ? 1 : sides && sides.has(-1) ? -1 : 1;
    const key = `${side}:${ring}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(id);
  }

  positions.set(focusId, { x: 0, y: 0 });
  for (const [key, group] of buckets) {
    const [sideStr, ringStr] = key.split(":");
    const side = Number(sideStr);
    const ring = Number(ringStr);
    const x = side * ring * ringGap;
    const startY = -((group.length - 1) * rowGap) / 2;
    group.forEach((id, i) => positions.set(id, { x, y: startY + i * rowGap }));
  }

  return positions;
}

/**
 * Deterministic grid layout for the whole-vault ("show all") view. Vaults are
 * small, so a simple column grid keeps it readable without a physics engine.
 * Ordering = entries order (already sorted by id upstream).
 */
export function layoutGrid(
  ids: string[],
  columns = 5,
): Map<string, { x: number; y: number }> {
  const colGap = 240;
  const rowGap = 96;
  const positions = new Map<string, { x: number; y: number }>();
  ids.forEach((id, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    positions.set(id, { x: col * colGap, y: row * rowGap });
  });
  return positions;
}
