"use client";

/**
 * SliceSubscriptions — the PROJECT-plane per-source slice-subscription grid.
 *
 * This panel moved OFF the global Sources registry (Fix B): subscribing is a
 * per-project choice that scopes the active project's catalog READ-VIEW (core ∪
 * the slices this project subscribes to, ADR-0018), so it belongs on the project
 * browse&adopt surface — not the install-wide source registry.
 *
 * Read side: the server page passes the `forge slice list` envelope (one entry
 * per source with its per-(source, kind) slices). Action side: toggling a slice
 * rides POST /api/slices { action:"subscribe"|"unsubscribe", sliceId } (active
 * scope; the bridge resolves the project root), then router.refresh() re-runs the
 * server reads so the browse table's read-view updates in lock-step.
 *
 * Opt-in is non-destructive and reversible, so a toggle fires immediately (no
 * confirm). The CONTRACT is unchanged — only the surface that calls it moved.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Boxes, Library, Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { SourceChip, TrustTag } from "@/components/forge";
import type { BridgeEnvelope, SliceListData } from "@/lib/types";

export function SliceSubscriptions({ data }: { data: SliceListData }) {
  const router = useRouter();
  const { sources } = data;

  // Per-slice in-flight slot so only the toggled row spins.
  const [sliceBusy, setSliceBusy] = React.useState<string | null>(null);

  const onToggle = React.useCallback(
    async (sliceId: string, subscribed: boolean) => {
      const action = subscribed ? "unsubscribe" : "subscribe";
      setSliceBusy(sliceId);
      try {
        const res = await fetch("/api/slices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ action, sliceId }),
        });
        const json = (await res.json()) as
          | BridgeEnvelope
          | { ok: false; error: string };
        if (!res.ok || !json.ok) {
          const msg =
            "error" in json && typeof json.error === "string"
              ? json.error
              : ((json as BridgeEnvelope).findings?.find(
                  (f) => f.level === "ERROR",
                )?.message ?? "Slice action failed.");
          toast.error(msg);
          return;
        }
        toast.success(
          subscribed
            ? `Unsubscribed from "${sliceId}".`
            : `Subscribed to "${sliceId}".`,
        );
        // Re-run the server reads so the browse table's read-view tracks the
        // new subscription set.
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSliceBusy(null);
      }
    },
    [router],
  );

  if (sources.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
        <span className="flex size-10 items-center justify-center rounded-md border border-border text-muted-foreground/60">
          <Library className="size-5" />
        </span>
        <p className="font-mono text-sm text-foreground">
          No source slices to subscribe to
        </p>
        <p className="max-w-md font-mono text-[length:var(--text-2xs)] leading-snug text-muted-foreground">
          Federate and sync a source on the{" "}
          <span className="text-foreground">Sources</span> page to surface its
          slices here. Subscribe to a slice to pull its resources into this
          project&apos;s read-view below — core resources always appear.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {sources.map((src) => {
        const total = src.slices.reduce((acc, sl) => acc + sl.count, 0);
        const subscribed = src.slices.filter((sl) => sl.subscribed).length;
        return (
          <div
            key={src.sourceId}
            className="overflow-hidden rounded-xl bg-card ring-1 ring-border"
          >
            {/* Header band — source provenance + the subscription summary. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <SourceChip source={src.sourceId} />
              <span className="font-mono text-sm font-semibold text-foreground">
                {src.sourceId}
              </span>
              <TrustTag
                label={`${total} resource${total === 1 ? "" : "s"} · ${subscribed}/${src.slices.length} slices subscribed`}
                icon={<Boxes />}
                className="ml-auto"
              />
            </div>

            {/* Per-slice subscribe toggle grid (`.src-slices`). New slices
                default UNSUBSCRIBED (opt-in); subscribing surfaces that slice's
                resources in the read-view below. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 border-t border-border bg-muted/[0.12] px-4 py-3">
              {src.slices.map((sl) => (
                <div
                  key={sl.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-[7px]"
                >
                  <Switch
                    checked={sl.subscribed}
                    disabled={sliceBusy === sl.id}
                    onCheckedChange={() => onToggle(sl.id, sl.subscribed)}
                    aria-label={`${sl.subscribed ? "Unsubscribe from" : "Subscribe to"} ${sl.id}`}
                  />
                  <span className="flex-1 truncate font-mono text-xs text-foreground">
                    {sl.name}
                  </span>
                  {sliceBusy === sl.id ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground/60" />
                  ) : (
                    <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/60">
                      {sl.count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
