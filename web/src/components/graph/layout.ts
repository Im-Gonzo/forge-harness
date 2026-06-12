/**
 * Dependency-free graph layout helpers. The repo has ~69 artifacts; a tidy
 * deterministic layout (no physics engine, no extra deps) keeps the canvas
 * readable and stable across refetches.
 */
import type { RegistryArtifact } from "./types";

/** Group nodes into columns by kind, lay each column out vertically. */
export function layoutByKind(
  items: { id: string; kind: string }[],
  kindOrder: string[],
): Map<string, { x: number; y: number }> {
  const colGap = 260;
  const rowGap = 64;
  const positions = new Map<string, { x: number; y: number }>();

  // Bucket by kind, preserving the supplied kind order for columns.
  const buckets = new Map<string, string[]>();
  for (const k of kindOrder) buckets.set(k, []);
  for (const it of items) {
    if (!buckets.has(it.kind)) buckets.set(it.kind, []);
    buckets.get(it.kind)!.push(it.id);
  }

  let col = 0;
  for (const [, ids] of buckets) {
    if (ids.length === 0) continue;
    ids.forEach((id, row) => {
      positions.set(id, { x: col * colGap, y: row * rowGap });
    });
    col += 1;
  }
  return positions;
}

/**
 * Three-tier layout for the composition graph: profiles (col 0) → modules
 * (col 1) → components (col 2). Returns positions keyed by node id.
 */
export function layoutTiers(
  profiles: string[],
  modules: string[],
  components: string[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const rowGap = 56;
  const place = (ids: string[], x: number) => {
    const total = ids.length;
    const startY = -((total - 1) * rowGap) / 2;
    ids.forEach((id, i) => positions.set(id, { x, y: startY + i * rowGap }));
  };
  place(profiles, 0);
  place(modules, 360);
  place(components, 760);
  return positions;
}

/**
 * Radial focus layout. The focus node sits at the origin; everything else is
 * placed in concentric rings by BFS hop distance from focus. Within a ring,
 * pure dependencies (only reachable downstream) fan out to the LEFT, pure
 * dependents (only reachable upstream) fan to the RIGHT, and nodes that are
 * both sit on the right. Kind is NOT a layout axis here — it stays as color.
 *
 * Deterministic and dependency-free: ring membership comes from a both-direction
 * BFS over the supplied uid set, and within each ring/side nodes keep `uids`
 * iteration order, so the same input always yields the same positions.
 */
export function layoutRadial(
  focusUid: string,
  uids: Set<string>,
  artifacts: RegistryArtifact[],
  reverseIndex: Record<string, string[]>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (!uids.has(focusUid)) return positions;

  const ringGap = 320; // horizontal distance between concentric rings
  const rowGap = 72; // vertical spacing within a ring/side

  const byUid = new Map<string, RegistryArtifact>();
  for (const a of artifacts) if (uids.has(a.uid)) byUid.set(a.uid, a);

  // Stable iteration order = the order uids appear in `artifacts`.
  const ordered = artifacts.filter((a) => uids.has(a.uid)).map((a) => a.uid);

  // Hop distance from focus + which direction(s) it was first reached through.
  const dist = new Map<string, number>();
  // side: -1 = dependency (left), +1 = dependent (right). Nodes reachable both
  // ways resolve to the right (+1) for placement.
  const sideHits = new Map<string, Set<number>>();
  const noteSide = (uid: string, side: number) => {
    (sideHits.get(uid) ?? sideHits.set(uid, new Set()).get(uid)!).add(side);
  };

  dist.set(focusUid, 0);
  let frontier: string[] = [focusUid];
  let d = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const uid of frontier) {
      const art = byUid.get(uid);
      // Downstream → dependencies (left).
      for (const dep of art?.dependsOn ?? []) {
        if (!uids.has(dep)) continue;
        if (!dist.has(dep)) {
          dist.set(dep, d + 1);
          next.push(dep);
        }
        if (dep !== focusUid) noteSide(dep, -1);
      }
      // Upstream → dependents (right).
      for (const dependent of reverseIndex[uid] ?? []) {
        if (!uids.has(dependent)) continue;
        if (!dist.has(dependent)) {
          dist.set(dependent, d + 1);
          next.push(dependent);
        }
        if (dependent !== focusUid) noteSide(dependent, 1);
      }
    }
    frontier = next;
    d += 1;
  }

  // Group by (ring, side); any uid never reached keeps focus's ring as a
  // fallback so nothing is dropped.
  const buckets = new Map<string, string[]>(); // key `${side}:${ring}`
  for (const uid of ordered) {
    if (uid === focusUid) continue;
    const ring = dist.get(uid) ?? 1;
    const sides = sideHits.get(uid);
    const side = sides && sides.has(1) ? 1 : sides && sides.has(-1) ? -1 : 1;
    const key = `${side}:${ring}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(uid);
  }

  positions.set(focusUid, { x: 0, y: 0 });
  for (const [key, ids] of buckets) {
    const [sideStr, ringStr] = key.split(":");
    const side = Number(sideStr);
    const ring = Number(ringStr);
    const x = side * ring * ringGap;
    const startY = -((ids.length - 1) * rowGap) / 2;
    ids.forEach((id, i) => positions.set(id, { x, y: startY + i * rowGap }));
  }

  return positions;
}
