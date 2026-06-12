"use client";

import { CrosshairIcon, GitBranchIcon, XIcon } from "lucide-react";

import { OpenInEditor } from "@/components/open-in-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResourceKind } from "@/lib/types";

import { KIND_COLORS, type RegistryArtifact } from "./types";

interface Props {
  artifact: RegistryArtifact;
  isOrphan: boolean;
  onClose: () => void;
  /** true when this artifact is the current focus node (lens centered on it). */
  isFocus?: boolean;
  /** Re-center the lens on this artifact. Hidden when already the focus. */
  onFocusHere?: () => void;
  /** Pull this artifact's neighbors into view (expand the lens around it). */
  onExpandNeighbors?: () => void;
}

/**
 * Artifact kinds the on-disk editor (/resources/[kind]/[id]) can open. The graph
 * registry includes validator/meta-test/engine kinds the editor doesn't route,
 * so the "Edit source" action only appears for editable, file-backed kinds.
 */
const EDITABLE_KINDS: ReadonlySet<ResourceKind> = new Set([
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "hook",
]);

function editableKind(kind: RegistryArtifact["kind"]): ResourceKind | null {
  return (EDITABLE_KINDS as ReadonlySet<string>).has(kind)
    ? (kind as ResourceKind)
    : null;
}

/** A floating right-side drawer describing the clicked artifact node. */
export function NodeDetailPanel({
  artifact,
  isOrphan,
  onClose,
  isFocus = false,
  onFocusHere,
  onExpandNeighbors,
}: Props) {
  const color = KIND_COLORS[artifact.kind] ?? "var(--muted-foreground)";
  // The panel only ever receives a real (file-backed) artifact — dangling
  // placeholder nodes don't map to a registry entry, so they never select here.
  const editKind = editableKind(artifact.kind);
  const deps = (artifact.dependsOn ?? []).filter((d) => !d.startsWith("module:"));
  const modDeps = (artifact.dependsOn ?? []).filter((d) =>
    d.startsWith("module:"),
  );

  return (
    <div className="absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-80 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: color }}
            />
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {artifact.kind}
            </span>
          </div>
          <h3 className="mt-0.5 truncate font-mono text-sm font-semibold">
            {artifact.id}
          </h3>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 font-mono text-[11px]">
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">{artifact.status}</Badge>
          <Badge variant="outline">{artifact.criticality}</Badge>
          <Badge variant="outline">v{artifact.version}</Badge>
          <Badge variant="outline">rev {artifact.revision}</Badge>
          {isOrphan ? <Badge variant="secondary">orphan</Badge> : null}
        </div>

        {artifact.description ? (
          <p className="leading-relaxed text-muted-foreground">
            {artifact.description}
          </p>
        ) : null}

        <Field label="uid" value={artifact.uid} />
        <Field label="path" value={artifact.path} />
        <Field label="owner" value={artifact.owner} />

        {artifact.modules?.length ? (
          <ListField label="modules" items={artifact.modules} />
        ) : null}
        {deps.length ? <ListField label="depends on" items={deps} /> : null}
        {modDeps.length ? (
          <ListField label="module deps" items={modDeps} />
        ) : null}
        {artifact.tags?.length ? (
          <ListField label="tags" items={artifact.tags} />
        ) : null}
      </div>

      {onFocusHere || onExpandNeighbors || editKind ? (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {onFocusHere && !isFocus ? (
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={onFocusHere}
            >
              <CrosshairIcon />
              Focus here
            </Button>
          ) : null}
          {onExpandNeighbors ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onExpandNeighbors}
            >
              <GitBranchIcon />
              Expand neighbors
            </Button>
          ) : null}
          {editKind ? (
            <OpenInEditor
              kind={editKind}
              id={artifact.id}
              label="Edit source"
              className="w-full"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}: </span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function ListField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>
      <ul className="mt-1 space-y-0.5 pl-3">
        {items.map((it) => (
          <li key={it} className="break-all">
            • {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
