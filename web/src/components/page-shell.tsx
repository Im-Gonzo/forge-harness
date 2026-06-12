import type { ReactNode } from "react";
import { Boxes, FolderGit2, Globe } from "lucide-react";

import { cn } from "@/lib/utils";
import { getActiveHarness } from "@/lib/harness";

/**
 * Which scope indicator the topbar shows:
 *  - "active" (default): the per-project ACTIVE-harness badge (the cookie-scoped
 *    resource root every bridge call uses). Used by every project-scoped page.
 *  - "global": a subtle, calm "global" indicator. Used by pages that read the
 *    install-wide FORGE_HOME registry (the federated catalog + sources) rather
 *    than the selected project, so the per-project scope badge would be
 *    misleading there.
 */
type PageShellScope = "active" | "global";

type PageShellProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  /** Topbar scope indicator. Defaults to the per-project "active" badge. */
  scope?: PageShellScope;
};

/**
 * Standard dense page chrome: a thin topbar + padded content region, modeled on
 * the federated-catalog prototype `.topbar` (48px, mono title + crumb + scope
 * badge + actions, sitting under a faint backdrop blur and a hairline rule).
 * Shared across every dashboard route so they stay visually consistent.
 *
 * Server component — for the default ("active") scope it resolves the ACTIVE
 * harness (the cookie-scoped resource root every bridge call uses) and shows it
 * as a compact "scope" badge, so the user always sees which harness the page is
 * rendered against. For the "global" scope it skips that resolution and renders
 * a subtle "global" indicator instead (the catalog/sources read FORGE_HOME, not
 * the selected project).
 */
export async function PageShell({
  title,
  description,
  actions,
  children,
  scope = "active",
}: PageShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/80 px-5 py-1.5 backdrop-blur-[8px]">
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate font-mono text-[length:var(--text-md)] font-semibold tracking-[var(--tracking-tight)] leading-none">
            {title}
          </h1>
          {description ? (
            <p className="mt-0.5 font-mono text-[length:var(--text-2xs)] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 self-center">
          {scope === "global" ? <GlobalScopeBadge /> : <ActiveScopeBadge />}
          {actions ? (
            <div className="flex items-center gap-2">{actions}</div>
          ) : null}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-5">{children}</div>
    </div>
  );
}

/**
 * The per-project ACTIVE-harness badge (the default). Resolves the cookie-scoped
 * resource root and shows it, so the user sees which harness the page renders
 * against.
 */
async function ActiveScopeBadge() {
  const scope = await getActiveHarness();
  const isProject = scope.kind === "project";
  const ScopeIcon = isProject ? FolderGit2 : Boxes;

  return (
    <span
      className={cn(
        "flex max-w-44 items-center gap-1.5 whitespace-nowrap rounded-pill border border-border px-2.5 py-1",
        "font-mono text-[length:var(--text-2xs)] text-muted-foreground",
      )}
      title={`active scope: ${scope.label}`}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isProject ? "bg-state-ok" : "bg-neutral-400",
        )}
      />
      <ScopeIcon className="size-3 shrink-0 text-muted-foreground/80" />
      <span className="text-muted-foreground/70">scope</span>
      <span className="truncate text-foreground">{scope.label}</span>
    </span>
  );
}

/**
 * The subtle "global" indicator for install-wide pages (catalog/sources). These
 * read the FORGE_HOME registry, not the selected project, so they show a calm
 * global marker instead of a per-project scope. Kept deliberately quiet (muted,
 * hairline, no saturated dot) so it never reads as the active project badge.
 */
function GlobalScopeBadge() {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap rounded-pill border border-dashed border-border px-2.5 py-1",
        "font-mono text-[length:var(--text-2xs)] text-muted-foreground/70",
      )}
      title="global scope — the install-wide registry (FORGE_HOME), not the active project"
    >
      <Globe className="size-3 shrink-0 text-muted-foreground/70" />
      <span>global</span>
    </span>
  );
}
