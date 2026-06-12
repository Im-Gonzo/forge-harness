/**
 * /resources/[kind]/[id] — the per-resource EDIT route.
 *
 * Server component: it loads the resource through the bridge (readResource →
 * parsed { frontmatter, body }) and reads the verbatim file bytes (the baseline
 * the editor diffs against for minimal-diff + the Preview). Then it hands both to
 * the client <ResourceEditor> (Visual ⇄ Raw ⇄ Validate/Preview).
 *
 * The static `new` segment takes precedence over this dynamic `[id]`, so the
 * create route is reached at /resources/<kind>/new (page below renders the same
 * editor in create mode).
 */
import { promises as fs } from "node:fs";

import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { ResourceEditor } from "@/components/resource-editor";
import { readResource } from "@/lib/forge-bridge";
import type { ResourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const KINDS: readonly ResourceKind[] = [
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
  "hook",
  "workflow",
  "mcp",
];

function isKind(value: string): value is ResourceKind {
  return (KINDS as readonly string[]).includes(value);
}

export default async function ResourceEditPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind: rawKind, id: rawId } = await params;
  if (!isKind(rawKind)) notFound();
  const kind = rawKind;
  const id = decodeURIComponent(rawId);

  let initial: { frontmatter: Record<string, unknown>; body: string };
  let originalText: string;
  try {
    const resource = await readResource(kind, id);
    initial = { frontmatter: resource.frontmatter, body: resource.body };
    // The verbatim file bytes — the minimal-diff baseline. Hooks are a slice of
    // a shared JSON file; fall back to the serialized body for those.
    originalText =
      kind === "hook"
        ? resource.body
        : await fs.readFile(resource.path, "utf8");
  } catch {
    notFound();
  }

  return (
    <PageShell
      title={`${kind} · ${id}`}
      description="Edit this resource — Visual form, Raw text, or Validate/Preview. Writes run forge validate + registry build."
    >
      <ResourceEditor
        kind={kind}
        id={id}
        initial={initial}
        isNew={false}
        originalText={originalText}
      />
    </PageShell>
  );
}
