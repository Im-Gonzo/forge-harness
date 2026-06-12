"use client";

/**
 * SettingsPolicy — the EDITABLE adjudication-policy config (the one harness
 * config with a write verb).
 *
 * The per-criticality adjudication policy (ADR-0013/0020) maps each criticality
 * { normal, compliance, safety } to "auto" (conflicts adopted without an explicit
 * per-conflict pick) or "block" (explicit human adjudication required; the
 * conservative default). It is persisted in the scope's `.forge/adjudication.json`.
 *
 * This is the SCOPED editor: it reuses the EXISTING conflicts policy endpoint
 * (POST /api/conflicts { action:"policy", policy }), which targets the ACTIVE
 * harness scope inside the bridge — so editing here writes the policy for
 * whatever scope is active. The initial values arrive as a plain server-loaded
 * envelope (forge-bridge is server-only); the toggle posts the changed dims, then
 * router.refresh() re-reads. Fail-soft — a degraded read shows the defaults.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Scale, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AdjudicationPolicy } from "@/lib/types";

const DIMS = ["normal", "compliance", "safety"] as const;
type Dim = (typeof DIMS)[number];
type PolicyValue = "auto" | "block";

export interface SettingsPolicyProps {
  /** The active scope's current policy (default all-block on a degraded read). */
  policy: AdjudicationPolicy;
  /** Absolute path of the adjudication.json store (display), or null. */
  storePath?: string | null;
  /** Human label of the active scope being edited. */
  scopeLabel: string;
  /** Whether the policy read failed (then we show a degraded note). */
  degraded?: boolean;
}

const DIM_META: Record<Dim, { label: string; hint: string }> = {
  normal: { label: "normal", hint: "everyday resources" },
  compliance: { label: "compliance", hint: "policy / governance resources" },
  safety: { label: "safety", hint: "safety-critical resources" },
};

export function SettingsPolicy({
  policy,
  storePath,
  scopeLabel,
  degraded,
}: SettingsPolicyProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<Dim | null>(null);

  const setDim = React.useCallback(
    async (dim: Dim, value: PolicyValue) => {
      if (policy[dim] === value) return; // no-op
      setBusy(dim);
      try {
        const res = await fetch("/api/conflicts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "policy", policy: { [dim]: value } }),
          cache: "no-store",
        });
        const json = (await res.json()) as
          | { ok: true }
          | { ok: false; error?: string };
        if (!res.ok || !json.ok) {
          toast.error(
            ("error" in json && json.error) || "Failed to set policy.",
          );
          return;
        }
        toast.success(`Set ${dim} adjudication to "${value}".`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [policy, router],
  );

  return (
    <Card size="sm">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center gap-1.5 font-mono text-sm">
          <Scale className="size-3.5" />
          Adjudication policy
          <Badge
            variant="outline"
            className="font-mono text-[10px] uppercase text-emerald-600 dark:text-emerald-400"
          >
            editable
          </Badge>
        </CardTitle>
        <CardDescription className="font-mono text-[11px]">
          Per-criticality conflict policy for the active scope (
          <span>{scopeLabel}</span>): <code>block</code> requires explicit human
          adjudication (the conservative default); <code>auto</code> adopts the
          conflict at composition level without a per-conflict pick. A resolve
          that replaces an already-admitted library resource stays a human action
          even under <code>auto</code> (BR-CAT-003). Writes the scope&apos;s{" "}
          <code>.forge/adjudication.json</code> via the conflicts policy verb.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {degraded ? (
          <p className="flex items-center gap-1.5 font-mono text-[10px] italic text-amber-600 dark:text-amber-400">
            <ShieldAlert className="size-3" />
            could not read the live policy — showing defaults (all-block).
          </p>
        ) : null}

        <ul className="flex flex-col gap-1.5">
          {DIMS.map((dim) => {
            const current = policy[dim];
            const meta = DIM_META[dim];
            return (
              <li
                key={dim}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-2.5 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-mono text-[11px] text-foreground">
                    {meta.label}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    {meta.hint}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {(["block", "auto"] as const).map((value) => {
                    const active = current === value;
                    return (
                      <Button
                        key={value}
                        variant={active ? "default" : "outline"}
                        size="xs"
                        disabled={busy !== null}
                        onClick={() => setDim(dim, value)}
                        className={cn(
                          "font-mono text-[10px] uppercase",
                          active && value === "auto"
                            ? "border-amber-500/40"
                            : null,
                        )}
                        title={
                          value === "block"
                            ? "Require explicit human adjudication"
                            : "Adopt the conflict automatically (no per-conflict pick)"
                        }
                      >
                        {busy === dim && active ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : null}
                        {value}
                      </Button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>

        {storePath ? (
          <p className="break-all font-mono text-[10px] text-muted-foreground/70">
            store: {storePath}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
