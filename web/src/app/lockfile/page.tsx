import { AlertTriangle, FileLock } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/forge";
import { getLock, getLockDiff } from "@/lib/forge-bridge";
import { LockfileView } from "@/components/lockfile/lockfile-view";

// Live forge state (the per-project LOCKFILE: the RESOLVED composition manifest —
// the adopted set JOINed with tailoring overlays + adjudication choices + each
// entry's pinned version/commit, plus a deterministic content hash) — render on
// every request, never cache. The "write lock" / "bump & re-resolve" mutation
// rides POST /api/lock { action:"write" } and calls router.refresh(), which
// re-runs this server read.
//
// forge.lock is a MANIFEST ONLY — the project analogue of package-lock.json. It
// lives at the ACTIVE PROJECT ROOT, is git-committable, and is DISTINCT from
// .forge/sources.lock (which pins SOURCE commits). `lock write` writes ONLY the
// forge.lock manifest — it NEVER materializes/modifies any real .claude/ file, the
// library, or any resource content (that is the bootstrap composer's job, out of
// scope — ADR-0022).
export const dynamic = "force-dynamic";

export default async function LockfilePage() {
  // Two fail-soft reads: the lock itself (exists/committed/inSync + the parsed
  // contents) and the diff vs the freshly-resolved composition (+/~/- changes).
  // A bridge/CLI failure yields a non-ok envelope (never throws); the page renders
  // it as the error card below rather than crashing.
  const [env, diffEnv] = await Promise.all([getLock(), getLockDiff()]);
  const bridgeFailed = !env.ok;

  // The diff is advisory — when it fails we simply show the lock without an
  // "update available" banner (in-sync defers to the lock's own inSync flag).
  const diff = diffEnv.ok ? diffEnv.data : null;
  const exists = env.ok ? env.data.exists : false;
  const inSync = env.ok ? env.data.inSync : false;

  return (
    <PageShell
      title="Lockfile"
      description="forge.lock — the resolved per-project composition, frozen as a committable manifest (ADR-0022). Adopted set ∪ overlays ∪ adjudication + pinned refs + a deterministic hash. Manifest only — never materializes .claude/."
      actions={
        <StatusPill
          tone={!exists ? "neutral" : inSync ? "ok" : "attention"}
          icon={<FileLock className="size-3" />}
        >
          {!exists ? "no lock" : inSync ? "in sync" : "stale"}
        </StatusPill>
      }
    >
      {bridgeFailed ? (
        <Card className="ring-1 ring-state-attention/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-state-attention">
              <AlertTriangle className="size-4" />
              Could not load the lockfile
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {env.findings.length ? (
              env.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge lock show returned no data.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <LockfileView data={env.data} diff={diff} />
      )}
    </PageShell>
  );
}
