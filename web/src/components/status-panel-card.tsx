"use client";

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleSlash,
  Copy,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Tri-state health: true=ok, false=problem, null=no-data/off. */
export type PanelState = boolean | null;

function stateMeta(state: PanelState): {
  Icon: LucideIcon;
  className: string;
  label: string;
} {
  if (state === true)
    return { Icon: CheckCircle2, className: "text-emerald-500", label: "ok" };
  if (state === false)
    return { Icon: XCircle, className: "text-red-500", label: "attention" };
  return { Icon: CircleSlash, className: "text-muted-foreground", label: "no data" };
}

type StatusPanelCardProps = {
  title: string;
  state: PanelState;
  /** Optional big headline value (e.g. the artifact count). */
  metric?: ReactNode;
  /** Optional small caption under the metric. */
  caption?: ReactNode;
  /** Optional richer body content (breakdowns, lists, hints). */
  children?: ReactNode;
  /**
   * Optional route this panel drills into. When set the whole card becomes a
   * keyboard-accessible link to its detail page (with a hover/focus affordance);
   * when omitted the card is a plain, non-interactive panel (e.g. Fleet).
   */
  href?: string;
  className?: string;
};

/**
 * One forge status panel rendered as a shadcn card with a tri-state health dot.
 * Shared by every panel on the home dashboard so they read consistently.
 *
 * If `href` is given the entire card is wrapped in a Next <Link>, turning the
 * panel into a single large click/tap/Enter target that drills into its route.
 * The link sits behind the card content (`absolute inset-0`) so interactive
 * children could still be layered above it, but today panels are read-only.
 */
export function StatusPanelCard({
  title,
  state,
  metric,
  caption,
  children,
  href,
  className,
}: StatusPanelCardProps) {
  const { Icon, className: stateClass, label } = stateMeta(state);
  const linked = Boolean(href);
  return (
    <Card
      className={cn(
        "relative flex flex-col",
        linked &&
          "transition-colors focus-within:ring-2 focus-within:ring-ring/50 hover:bg-muted/30 hover:ring-foreground/20",
        className,
      )}
    >
      {href ? (
        // Stretched, keyboard-accessible link over the whole card. The label
        // names the destination for screen readers; the visible chevron is the
        // sighted affordance.
        <Link
          href={href}
          aria-label={`Open ${title}`}
          className="absolute inset-0 z-10 rounded-xl outline-none"
        />
      ) : null}
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
        <span className="flex items-center gap-1.5">
          <Icon className={cn("size-4", stateClass)} aria-hidden />
          <span className={cn("font-mono text-[10px]", stateClass)}>{label}</span>
          {linked ? (
            <ArrowUpRight
              className="size-3.5 text-muted-foreground transition-colors group-hover/card:text-foreground"
              aria-hidden
            />
          ) : null}
        </span>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        {metric !== undefined ? (
          <div className="font-mono text-3xl font-semibold leading-none tracking-tight">
            {metric}
          </div>
        ) : null}
        {caption !== undefined ? (
          <p className="font-mono text-xs text-muted-foreground">{caption}</p>
        ) : null}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * A single forge CLI "next action" rendered as a copy-able command line.
 *
 * This UI surfaces the suggested command and copies it to the clipboard so it
 * can be pasted into a terminal — it deliberately does NOT run it. Copy is a
 * convenience: the command stays visible + selectable if the clipboard API is
 * unavailable (e.g. an insecure context).
 */
export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Fail-soft: clipboard may be unavailable; the command stays selectable.
      });
  }, [command]);

  return (
    <li className="flex items-stretch gap-2">
      <code className="flex flex-1 items-center overflow-x-auto rounded bg-muted/40 px-2 py-1 font-mono text-xs text-foreground">
        <span className="whitespace-pre">$ {command}</span>
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={copy}
        aria-label={copied ? "Copied command" : `Copy command: ${command}`}
        className="shrink-0"
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </li>
  );
}
