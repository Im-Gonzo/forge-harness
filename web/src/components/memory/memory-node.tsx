"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { memoryTypeColor } from "./memory-colors";

/**
 * Data carried by every memory canvas node. Entry nodes set {label, type,
 * degree, confidence, orphan, focus}; a dangling wiki-link target sets
 * {label, dangling}.
 */
export interface MemoryNodeData {
  label: string;
  /** memory-type tag (decision/gotcha/… or a coarse domain tag), or null. */
  type?: string | null;
  /** in+out resolved-link count, drives node sizing (hubs pop). */
  degree?: number;
  /** numeric confidence (0..1 or 0..100) → ring/opacity, or null. */
  confidence?: number | null;
  /** true → dimmed + dashed (zero in/out links). */
  orphan?: boolean;
  /** true → the current focus (lens centered here). */
  focus?: boolean;
  /** true → red dashed ghost (an unresolved [[wiki-link]] target). */
  dangling?: boolean;
  [key: string]: unknown;
}

/** Map degree → a gentle 0.9..1.45 scale so hubs read larger but stay tidy. */
function degreeScale(degree: number | undefined): number {
  const d = degree ?? 0;
  // sqrt keeps growth sublinear; clamp so a mega-hub doesn't blow out.
  return Math.min(1.45, 0.9 + Math.sqrt(d) * 0.16);
}

/**
 * Normalize confidence to 0..1. Live entries have none (null → treated as
 * fully solid). Values >1 are assumed to be a 0..100 percentage.
 */
function normConfidence(confidence: number | null | undefined): number | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  const v = confidence > 1 ? confidence / 100 : confidence;
  return Math.max(0, Math.min(1, v));
}

/**
 * A compact memory entry card. Colored by memory-type, sized by link degree,
 * with a confidence ring when present and a dim/dashed treatment for orphans.
 * Dangling targets render as a red ghost. Mirrors graph/artifact-node.tsx.
 */
export function MemoryNode({ data, selected }: NodeProps) {
  const d = data as MemoryNodeData;
  const color = memoryTypeColor(d.type);
  const scale = d.dangling ? 1 : degreeScale(d.degree);
  const conf = normConfidence(d.confidence);
  // Confidence-less (live) entries render solid; otherwise dim by confidence.
  const opacity = d.orphan ? undefined : conf == null ? 1 : 0.55 + conf * 0.45;

  if (d.dangling) {
    return (
      <div
        className="memory-node"
        data-dangling="true"
        title={`${d.label} (unresolved wiki-link)`}
      >
        <Handle type="target" position={Position.Left} />
        <div className="memory-node__type">dangling</div>
        <div className="memory-node__title">{d.label}</div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div
      className="memory-node"
      data-selected={selected ? "true" : "false"}
      data-focus={d.focus ? "true" : "false"}
      data-orphan={d.orphan ? "true" : "false"}
      style={{
        ["--accent-color" as string]: color,
        ["--node-scale" as string]: String(scale),
        ["--node-opacity" as string]: opacity != null ? String(opacity) : "1",
        position: "relative",
      }}
      title={d.label}
    >
      <Handle type="target" position={Position.Left} />
      {/* Confidence ring: only when a numeric confidence exists. */}
      {conf != null ? (
        <span
          className="memory-node__ring"
          style={{ opacity: 0.25 + conf * 0.75 }}
        />
      ) : null}
      <div className="memory-node__type">
        <span className="memory-node__dot" style={{ background: color }} />
        {d.type ?? "memory"}
      </div>
      <div className="memory-node__title">{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
