/**
 * /resources/[kind]/new — the per-kind CREATE route.
 *
 * Renders the SAME <ResourceEditor> in create mode (isNew): an empty draft, an
 * editable id field, and a "Create" action that POSTs to /api/resource/[kind]/[id]
 * (which refuses to overwrite an existing file — create is additive). The static
 * `new` segment wins over the dynamic `[id]` edit route.
 *
 * The starter frontmatter is a minimal, kind-appropriate skeleton so the Visual
 * form has the expected keys present (and in a sensible order) from the start.
 */
import { notFound } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { ResourceEditor } from "@/components/resource-editor";
import type { ResourceDraft } from "@/components/resource-editor";
import type { ResourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

// Memory is intentionally NOT writable here: memory entries are project-local
// (created via the /fleet/[id] Memory tab), so the library "+ New" must not
// create a mis-located library memory entry. The ResourceKind type is unchanged.
const WRITABLE_KINDS: readonly ResourceKind[] = [
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "workflow",
  "mcp",
];

function isWritableKind(value: string): value is ResourceKind {
  return (WRITABLE_KINDS as readonly string[]).includes(value);
}

/** A minimal starter draft per kind — keys present + in a sensible order. */
function starterDraft(kind: ResourceKind): ResourceDraft {
  switch (kind) {
    case "agent":
      return {
        frontmatter: { name: "", description: "", tools: ["Read"] },
        body: "\n# new agent\n\nDescribe the agent's method here.\n",
      };
    case "skill":
      return {
        frontmatter: { name: "", description: "" },
        body: "\n# new skill\n\nDescribe what this skill does and when to use it.\n",
      };
    case "command":
      return {
        frontmatter: { description: "" },
        body: "\nDescribe the slash command behaviour here.\n",
      };
    case "rule":
      return {
        frontmatter: { name: "", description: "" },
        body: "\n# new rule\n\nState the rule.\n",
      };
    case "bundle":
      return {
        frontmatter: { id: "", title: "", version: 1, status: "draft" },
        body: "\n# new bundle\n",
      };
    case "workflow":
      return {
        frontmatter: { name: "", description: "", phases: [] },
        body: "\n# new workflow\n\nDescribe the workflow and what each phase does.\n",
      };
    case "mcp":
      // mcp is RAW JSON — no frontmatter; the body IS the file. The skeleton is a
      // minimal mcpServers map edited in the Raw tab.
      return {
        frontmatter: {},
        body: '{\n  "mcpServers": {\n    "<name>": { "command": "", "args": [] }\n  }\n}\n',
      };
    default:
      return { frontmatter: {}, body: "\n" };
  }
}

export default async function ResourceCreatePage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind: rawKind } = await params;
  if (!isWritableKind(rawKind)) notFound();
  const kind = rawKind;

  return (
    <PageShell
      title={`New ${kind}`}
      description="Create a new resource — fill the Visual form or edit Raw, then Create. The write runs forge validate + registry build."
    >
      <ResourceEditor
        kind={kind}
        id=""
        initial={starterDraft(kind)}
        isNew
      />
    </PageShell>
  );
}
