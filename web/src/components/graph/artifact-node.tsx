"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { KIND_COLORS } from "./types";

/** Data carried by every graph node (dependency + composition share this). */
export interface ArtifactNodeData {
  label: string;
  kind: string;
  /** true → dashed border (orphan / no inbound dependents). */
  orphan?: boolean;
  /** true → red treatment (a dangling-ref placeholder node). */
  dangling?: boolean;
  /** true → highlighted as a valid drop target during a composition drag. */
  dropTarget?: boolean;
  [key: string]: unknown;
}

/**
 * A compact card node colored by artifact kind. Used by both graphs. The kind
 * dot + accent come from KIND_COLORS; orphan/dangling/drop-target states are
 * data-attribute driven (see graph.css).
 */
export function ArtifactNode({ data, selected }: NodeProps) {
  const d = data as ArtifactNodeData;
  const color = KIND_COLORS[d.kind] ?? "var(--muted-foreground)";
  return (
    <div
      className="forge-node"
      data-selected={selected ? "true" : "false"}
      data-orphan={d.orphan ? "true" : "false"}
      data-dangling={d.dangling ? "true" : "false"}
      data-droptarget={d.dropTarget ? "true" : "false"}
      style={{ ["--accent-color" as string]: color }}
      title={d.label}
    >
      <Handle type="target" position={Position.Left} />
      <div className="forge-node__kind">
        <span className="forge-node__dot" style={{ background: color }} />
        {d.kind}
      </div>
      <div className="forge-node__title">{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
