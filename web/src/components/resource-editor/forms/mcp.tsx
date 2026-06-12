"use client";

/**
 * forms/mcp — Visual "form" for an MCP server config (mcp/<id>.json).
 *
 * Resolved by CONVENTION (the shell dynamic-imports `forms/mcp` for kind "mcp";
 * there is no registry to edit). Unlike the markdown kinds, an mcp resource is
 * RAW JSON: it has NO frontmatter (the bridge always returns `frontmatter: {}`),
 * and the entire `{ "mcpServers": { … } }` config lives in the body. The body is
 * NOT part of the ResourceFormProps contract (forms edit structured frontmatter
 * only), so there is nothing for a Visual form to bind to here.
 *
 * Accordingly this is an INFORMATIONAL panel only: it directs the author to the
 * Raw tab, where the Monaco JSON editor edits the config verbatim (the bridge /
 * serialize layer round-trips mcp as raw JSON with no gray-matter). The body
 * preview the shell renders below the form already shows the live JSON.
 */
import type { ResourceFormProps } from "../types";

export default function McpForm({ isNew }: ResourceFormProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-dashed border-border p-4">
        <p className="font-mono text-xs font-medium text-foreground">
          MCP server config (JSON)
        </p>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          An mcp resource is raw JSON with no structured frontmatter — the whole{" "}
          <span className="text-foreground">
            {"{ \"mcpServers\": { … } }"}
          </span>{" "}
          config lives in the file body. Edit it in the{" "}
          <span className="text-foreground">Raw</span> tab; the body preview below
          shows the live config. Writes persist the JSON bytes verbatim.
        </p>
      </div>

      {isNew ? (
        <p className="font-mono text-[11px] text-muted-foreground/60">
          The mcp id is the file name (mcp/&lt;id&gt;.json). Fill in the server
          name and its <span className="text-foreground">command</span> /{" "}
          <span className="text-foreground">args</span> in the Raw tab.
        </p>
      ) : null}
    </div>
  );
}
