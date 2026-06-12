/**
 * resource-editor/diff — a tiny line-level LCS diff for the additive-write
 * PREVIEW. Renders what the NEXT write would change versus the file on disk
 * (or "(new file)" on create). Pure, dependency-free — minimal-diff is the whole
 * point, so the preview is usually one or two lines.
 */

export type DiffLineKind = "ctx" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the OLD text, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the NEW text, or null for a deleted line. */
  newLine: number | null;
  text: string;
}

/** Longest-common-subsequence table over two line arrays. */
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Compute a line-level diff between `oldText` and `newText`. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const dp = lcs(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", oldLine: i + 1, newLine: null, text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", oldLine: null, newLine: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ kind: "del", oldLine: i + 1, newLine: null, text: a[i] });
    i++;
  }
  while (j < b.length) {
    out.push({ kind: "add", oldLine: null, newLine: j + 1, text: b[j] });
    j++;
  }
  return out;
}

/** True when the two texts differ. */
export function hasChanges(oldText: string, newText: string): boolean {
  return oldText !== newText;
}

/**
 * Collapse a full diff to changed hunks with a few lines of surrounding context,
 * so the preview shows the minimal-diff cleanly instead of the whole file.
 */
export function toHunks(lines: DiffLine[], context = 2): DiffLine[][] {
  const changedIdx = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind !== "ctx") {
      for (let k = idx - context; k <= idx + context; k++) {
        if (k >= 0 && k < lines.length) changedIdx.add(k);
      }
    }
  });
  const hunks: DiffLine[][] = [];
  let current: DiffLine[] | null = null;
  for (let idx = 0; idx < lines.length; idx++) {
    if (changedIdx.has(idx)) {
      if (!current) {
        current = [];
        hunks.push(current);
      }
      current.push(lines[idx]);
    } else {
      current = null;
    }
  }
  return hunks;
}
