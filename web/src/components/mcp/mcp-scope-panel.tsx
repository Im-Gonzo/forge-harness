"use client";

/**
 * McpScopePanel — the DUAL-SCOPE MCP-servers manager (one panel per scope).
 *
 * The /mcp page renders TWO of these: one MACHINE/global panel (scope="machine",
 * the library's own `.claude/settings.json`) and one PROJECT panel
 * (scope="project", the selected project's `<project>/.claude/settings.json`).
 * The management UI is identical to the panel that previously lived under
 * /settings — it was generalized here so a single component drives both scopes,
 * routing every action to the correct `/api/mcp` scope. (The active-scope
 * /api/settings/mcp surface is preserved untouched.)
 *
 * Per row:
 *   DISABLED → "Enable":  PREVIEW { action:"enable", name } (show plan.add +
 *     any skipped/conflict findings in a disclosure) → guarded "Apply"
 *     { action:"enable", name, apply:true } — ADDITIVELY merges the component's
 *     mcpServers into settings.json, never clobbering an existing same-named one.
 *   ENABLED  → "Disable": PREVIEW { action:"disable", name } → guarded "Apply"
 *     { action:"disable", name, apply:true } — removes ONLY that component's keys,
 *     preserving the rest of settings.json.
 *
 * forge-bridge is server-only, so this client component NEVER imports it. The
 * read side (the catalog list) arrives as a plain server-loaded envelope; every
 * ACTION rides POST /api/mcp with the panel's { scope, project? } (client → API
 * route → bridge → CLI). Types are imported type-only from the specific bridge
 * module path (erased at build — safe across the client boundary).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  FileWarning,
  FolderGit2,
  Info,
  Loader2,
  Plug,
  Power,
  PowerOff,
  XCircle,
} from "lucide-react";

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
import type { BridgeEnvelope, Finding } from "@/lib/types";
import type {
  ProjectMcpDisableData,
  ProjectMcpEnableData,
  ProjectMcpListData,
  ProjectMcpServer,
} from "@/lib/forge-bridge/mcp-project";

// ──────────────────────────────────────────────────────────────────────────
// Props — plain server-loaded envelope (forge-bridge is server-only).
// ──────────────────────────────────────────────────────────────────────────

export type McpScope = "machine" | "project";

export interface McpScopePanelProps {
  /** Which scope this panel manages — drives the POST body + the heading. */
  scope: McpScope;
  /** Human label of the scope (e.g. "Library" or the project dir name). */
  scopeLabel: string;
  /**
   * The selected project's ABSOLUTE path — REQUIRED for scope="project" (threaded
   * into every action body), ignored for scope="machine".
   */
  projectPath?: string | null;
  /** `forge mcp list` envelope (the scope's catalog + enabled state), or null. */
  mcp: BridgeEnvelope<ProjectMcpListData> | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Small display helpers
// ──────────────────────────────────────────────────────────────────────────

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] italic text-muted-foreground/70">
      {children}
    </p>
  );
}

function findingClass(level: Finding["level"]): string {
  switch (level) {
    case "ERROR":
      return "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400";
    case "WARN":
      return "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400";
    default:
      return "border-border bg-muted/30 text-muted-foreground";
  }
}

function FindingIcon({ level }: { level: Finding["level"] }) {
  if (level === "ERROR") return <XCircle className="mt-0.5 size-3 shrink-0" />;
  if (level === "WARN")
    return <FileWarning className="mt-0.5 size-3 shrink-0" />;
  return <Info className="mt-0.5 size-3 shrink-0" />;
}

function envelopeMessage(env: BridgeEnvelope, fallback: string): string {
  const finding =
    env.findings?.find((f) => f.level === "ERROR") ??
    env.findings?.find((f) => f.level === "WARN");
  return finding?.message ?? fallback;
}

function PlanKeys({
  label,
  keys,
  tone,
}: {
  label: string;
  keys: string[] | undefined;
  tone: "add" | "remove" | "skip" | "missing";
}) {
  const palette =
    tone === "add"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : tone === "remove"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={cn("font-mono text-[10px]", palette)}
      title={(keys ?? []).join(", ") || undefined}
    >
      {label} {keys?.length ?? 0}
    </Badge>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// McpScopePanel — read render (catalog rows) + per-row guarded enable/disable.
// ──────────────────────────────────────────────────────────────────────────

type Busy =
  | null
  | {
      name: string;
      phase:
        | "enable-preview"
        | "enable-apply"
        | "disable-preview"
        | "disable-apply";
    };

interface RowPreview {
  name: string;
  mode: "enable" | "disable";
  data: ProjectMcpEnableData | ProjectMcpDisableData;
  findings: Finding[];
}

export function McpScopePanel({
  scope,
  scopeLabel,
  projectPath,
  mcp,
}: McpScopePanelProps) {
  const router = useRouter();

  const servers: ProjectMcpServer[] = mcp?.data?.servers ?? [];
  const enabledCount = servers.filter((s) => s.enabled).length;
  const catalog = mcp?.data?.catalog ?? null;
  const ScopeIcon = scope === "project" ? FolderGit2 : Boxes;

  const [busy, setBusy] = React.useState<Busy>(null);
  const isBusy = busy !== null;
  const [preview, setPreview] = React.useState<RowPreview | null>(null);

  const isRowBusy = React.useCallback(
    (name: string, phase: NonNullable<Busy>["phase"]) =>
      busy != null && busy.name === name && busy.phase === phase,
    [busy],
  );

  // ── POST helper — every action rides /api/mcp with this panel's scope ──────
  const post = React.useCallback(
    async <T,>(
      body: Record<string, unknown>,
    ): Promise<BridgeEnvelope<T> | null> => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          ...(scope === "project" ? { project: projectPath } : {}),
          ...body,
        }),
        cache: "no-store",
      });
      const json = (await res.json()) as
        | BridgeEnvelope<T>
        | { ok: false; error: string };
      if (!res.ok || !json.ok) {
        toast.error(
          "error" in json && typeof json.error === "string"
            ? json.error
            : envelopeMessage(json as BridgeEnvelope, "MCP action failed."),
        );
        return null;
      }
      return json as BridgeEnvelope<T>;
    },
    [scope, projectPath],
  );

  const onEnablePreview = React.useCallback(
    async (name: string) => {
      setBusy({ name, phase: "enable-preview" });
      try {
        const env = await post<ProjectMcpEnableData>({ action: "enable", name });
        if (!env) return;
        setPreview({
          name,
          mode: "enable",
          data: env.data,
          findings: env.findings ?? [],
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post],
  );

  const onEnableApply = React.useCallback(
    async (name: string) => {
      setBusy({ name, phase: "enable-apply" });
      try {
        const env = await post<ProjectMcpEnableData>({
          action: "enable",
          name,
          apply: true,
        });
        if (!env) return;
        const added = env.data?.plan?.add?.length ?? 0;
        toast.success(
          added
            ? `Enabled ${name} — merged ${added} server key${added === 1 ? "" : "s"} into settings.json.`
            : `${name} already enabled — settings.json unchanged.`,
        );
        setPreview(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post, router],
  );

  const onDisablePreview = React.useCallback(
    async (name: string) => {
      setBusy({ name, phase: "disable-preview" });
      try {
        const env = await post<ProjectMcpDisableData>({
          action: "disable",
          name,
        });
        if (!env) return;
        setPreview({
          name,
          mode: "disable",
          data: env.data,
          findings: env.findings ?? [],
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post],
  );

  const onDisableApply = React.useCallback(
    async (name: string) => {
      setBusy({ name, phase: "disable-apply" });
      try {
        const env = await post<ProjectMcpDisableData>({
          action: "disable",
          name,
          apply: true,
        });
        if (!env) return;
        const removed = env.data?.plan?.remove?.length ?? 0;
        toast.success(
          removed
            ? `Disabled ${name} — removed ${removed} server key${removed === 1 ? "" : "s"} from settings.json.`
            : `${name} was not present — settings.json unchanged.`,
        );
        setPreview(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post, router],
  );

  // scope="project" with no project selected → a calm "select a project" state.
  const noProject = scope === "project" && !projectPath;

  return (
    <Card size="sm">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 font-mono text-sm">
          <span className="flex items-center gap-1.5">
            <ScopeIcon className="size-3.5" />
            {scope === "project" ? "Project MCP servers" : "Machine MCP servers"}
            <Badge
              variant="outline"
              className="font-mono text-[10px] uppercase text-muted-foreground"
              title={`scope: ${scopeLabel}`}
            >
              {scope === "project" ? "project" : "machine"}
            </Badge>
          </span>
          {!noProject ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {enabledCount}/{servers.length} enabled
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription className="font-mono text-[11px]">
          {scope === "project" ? (
            <>
              MCP catalog for the selected project (<span>{scopeLabel}</span>) and
              whether each component is enabled in its
              <code> .claude/settings.json</code> (where Claude Code reads
              <code> mcpServers</code>). Enable / disable previews the plan first,
              then APPLY writes that project&apos;s settings.json.
            </>
          ) : (
            <>
              MCP catalog for the machine / library scope (<span>{scopeLabel}</span>)
              and whether each component is enabled in the library&apos;s
              <code> .claude/settings.json</code>. Enable / disable previews the
              plan first, then APPLY writes the library settings.json.
            </>
          )}{" "}
          Enable merges additively (never clobbers an existing same-named server);
          disable removes only that server&apos;s keys.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {noProject ? (
          <EmptyHint>
            no project selected — pick a project on the Projects page to manage
            its MCP servers.
          </EmptyHint>
        ) : (
          <>
            {catalog ? (
              <p className="break-all font-mono text-[10px] text-muted-foreground/70">
                catalog: {catalog}
              </p>
            ) : null}

            {servers.length ? (
              <ul className="flex flex-col gap-1.5">
                {servers.map((s) => {
                  const open = preview?.name === s.name;
                  return (
                    <li
                      key={s.name}
                      className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 px-2.5 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate font-mono text-[11px] text-foreground"
                            title={s.name}
                          >
                            {s.name}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "font-mono text-[10px] uppercase",
                              s.enabled
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "border-border bg-muted/40 text-muted-foreground",
                            )}
                          >
                            {s.enabled ? (
                              <CheckCircle2 className="size-3" />
                            ) : (
                              <XCircle className="size-3" />
                            )}
                            {s.enabled ? "enabled" : "disabled"}
                          </Badge>
                          {s.servers.length ? (
                            <span
                              className="hidden truncate font-mono text-[10px] text-muted-foreground/60 sm:inline"
                              title={s.servers.join(", ")}
                            >
                              {s.servers.join(", ")}
                            </span>
                          ) : null}
                        </div>

                        {s.enabled ? (
                          <Button
                            variant={
                              open && preview?.mode === "disable"
                                ? "secondary"
                                : "outline"
                            }
                            size="xs"
                            disabled={isBusy}
                            onClick={() => onDisablePreview(s.name)}
                            title="Preview removing this server from settings.json"
                          >
                            {isRowBusy(s.name, "disable-preview") ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <PowerOff className="size-3" />
                            )}
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant={
                              open && preview?.mode === "enable"
                                ? "secondary"
                                : "outline"
                            }
                            size="xs"
                            disabled={isBusy}
                            onClick={() => onEnablePreview(s.name)}
                            title="Preview merging this server into settings.json"
                          >
                            {isRowBusy(s.name, "enable-preview") ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Power className="size-3" />
                            )}
                            Enable
                          </Button>
                        )}
                      </div>

                      {open && preview ? (
                        <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {preview.mode === "enable" ? (
                              <>
                                <PlanKeys
                                  label="add"
                                  keys={preview.data.plan?.add}
                                  tone="add"
                                />
                                <PlanKeys
                                  label="skip"
                                  keys={preview.data.plan?.skipped}
                                  tone="skip"
                                />
                              </>
                            ) : (
                              <>
                                <PlanKeys
                                  label="remove"
                                  keys={preview.data.plan?.remove}
                                  tone="remove"
                                />
                                <PlanKeys
                                  label="missing"
                                  keys={preview.data.plan?.missing}
                                  tone="missing"
                                />
                              </>
                            )}
                          </div>

                          {preview.data.settingsPath ? (
                            <p className="break-all font-mono text-[10px] text-muted-foreground/70">
                              {preview.data.settingsPath}
                            </p>
                          ) : null}

                          {preview.findings.length ? (
                            <ul className="flex flex-col gap-1">
                              {preview.findings.map((f, i) => (
                                <li
                                  key={`${f.path}:${f.line ?? ""}:${i}`}
                                  className={cn(
                                    "flex items-start gap-1.5 rounded border px-2 py-1 font-mono text-[10px]",
                                    findingClass(f.level),
                                  )}
                                >
                                  <FindingIcon level={f.level} />
                                  <span className="min-w-0">{f.message}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}

                          <div className="flex items-center justify-between gap-2">
                            {preview.mode === "enable" ? (
                              <p className="flex items-start gap-1.5 font-mono text-[10px] italic text-muted-foreground/70">
                                <ChevronRight className="mt-0.5 size-3 shrink-0" />
                                Apply MERGES{" "}
                                {preview.data.plan?.add?.length ?? 0} server key
                                {(preview.data.plan?.add?.length ?? 0) === 1
                                  ? ""
                                  : "s"}{" "}
                                into settings.json (additive — never clobbers an
                                existing same-named server).
                              </p>
                            ) : (
                              <p className="flex items-start gap-1.5 font-mono text-[10px] italic text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                                Apply REMOVES{" "}
                                {preview.data.plan?.remove?.length ?? 0} server key
                                {(preview.data.plan?.remove?.length ?? 0) === 1
                                  ? ""
                                  : "s"}{" "}
                                from settings.json (preserves the rest of the file).
                              </p>
                            )}

                            <div className="flex shrink-0 items-center gap-1.5">
                              <Button
                                variant="ghost"
                                size="xs"
                                disabled={isBusy}
                                onClick={() => setPreview(null)}
                              >
                                close
                              </Button>
                              {preview.mode === "enable" ? (
                                <Button
                                  variant="default"
                                  size="xs"
                                  disabled={isBusy}
                                  onClick={() => onEnableApply(s.name)}
                                >
                                  {isRowBusy(s.name, "enable-apply") ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <Power className="size-3" />
                                  )}
                                  Apply enable
                                </Button>
                              ) : (
                                <Button
                                  variant="destructive"
                                  size="xs"
                                  disabled={isBusy}
                                  onClick={() => onDisableApply(s.name)}
                                >
                                  {isRowBusy(s.name, "disable-apply") ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <PowerOff className="size-3" />
                                  )}
                                  Apply disable
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyHint>
                no MCP servers in this scope&apos;s catalog.
                <Plug className="ml-1 inline size-3 align-text-bottom" />
              </EmptyHint>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
