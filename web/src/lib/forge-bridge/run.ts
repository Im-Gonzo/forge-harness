/**
 * forge-bridge/run — the ONLY shell-out to the forge CLI.
 *
 * Every read of live forge state goes through `runForge`, which spawns
 *   node <FORGE_BIN> <cmd> ...args --json
 * with **cwd = the ACTIVE harness root** (`getActiveRoot()` — FORGE_ROOT by
 * default, or a selected project's `<project>/.claude`). This is critical: the
 * CLI resolves `.forge/registry.json` relative to cwd — wrong cwd ⇒ no-data — so
 * scoping cwd to the active root is what auto-scopes the whole app to a harness
 * with NO page changes. Stdout is parsed as the C3 envelope.
 *
 * Fail-soft: a spawn error, non-JSON stdout, or a malformed envelope never
 * throws. It returns a synthesized `BridgeEnvelope` with `ok: false`,
 * `bridgeError: true`, and the cause as a single ERROR finding — so callers and
 * the UI handle failure exactly like any other envelope.
 */
import { spawn } from "node:child_process";

import { FORGE_BIN } from "@/lib/config";
import { getActiveRoot } from "@/lib/harness";
import type { BridgeEnvelope, Envelope, Finding } from "@/lib/types";

// NOTE: server-only module. It uses node:child_process / node:fs and must be
// imported solely from server components and route handlers, never from a
// "use client" boundary.

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  /** True when stdout was truncated because it blew past MAX_STDOUT_BYTES. */
  oversize?: boolean;
}

/**
 * DEFENSIVE size cap (F11 belt-and-suspenders). The CLI now emits a SUMMARIZED catalog
 * payload (manager/catalog.mjs summarizes per-record security evidence), so a real list
 * is well under a megabyte. But a regression — or any verb that forgets to trim — could
 * still stream a huge string here; accumulating + JSON.parse-ing ~189 MB wedges the
 * server. So we hard-cap accumulation: past this many bytes we stop buffering, kill the
 * child, and fail SOFT to a bridgeError ("output too large — payload must be trimmed")
 * rather than parse a giant string. With the CLI fix in place this guard never fires.
 */
const MAX_STDOUT_BYTES = 20 * 1024 * 1024; // ~20 MB

/**
 * Optional per-call overrides for runForge/spawnForge. Additive: every field is
 * optional and the defaults reproduce the original behaviour.
 *
 * `cwd` — the working directory to spawn the CLI in. DEFAULTS to the ACTIVE root
 * (`getActiveRoot()`): FORGE_ROOT when no harness cookie is set (the library, so
 * the app behaves exactly as before), or a selected project's `<project>/.claude`
 * dir — the forge CLI resolves `.forge/registry.json` against cwd, so this is how
 * every bridge call auto-scopes to the active harness with NO page changes.
 * Pass an explicit ABSOLUTE path here to OVERRIDE that default for the genuinely
 * cwd-scoped verbs that target a specific dir regardless of the active harness
 * (e.g. fleet verbs passed a project path, or `forge memory *`).
 */
export interface RunForgeOptions {
  /** Working directory for the spawned CLI. Defaults to the active root. */
  cwd?: string;
}

function spawnForge(
  cmd: string,
  args: string[],
  opts?: RunForgeOptions,
): Promise<SpawnResult> {
  // The forge CLI treats `<cmd>` as one or more leading tokens (e.g. "registry
  // ls"). We pass the command as-is (split on whitespace) followed by args and
  // the always-on --json flag.
  const cmdTokens = cmd.trim().split(/\s+/).filter(Boolean);
  const argv = [FORGE_BIN, ...cmdTokens, ...args, "--json"];

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn("node", argv, {
      // The cwd is the load-bearing line: it scopes the CLI to a harness root.
      // runForge always resolves it (active root, or an explicit override) before
      // calling spawnForge, so opts.cwd is set by the time we get here.
      cwd: opts?.cwd,
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let oversize = false;

    child.stdout.on("data", (chunk: Buffer) => {
      // DEFENSIVE cap: stop accumulating past MAX_STDOUT_BYTES and kill the child so a
      // runaway payload can never wedge the server (we fail-soft in runForge below).
      if (oversize) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        oversize = true;
        try {
          child.kill();
        } catch {
          /* best-effort — the close handler still resolves */
        }
        return; // do NOT append this (or any further) chunk
      }
      // Collect raw Buffers and decode ONCE at close. Decoding per-chunk with
      // chunk.toString() corrupts any multi-byte UTF-8 sequence that straddles a
      // 64 KB stream-chunk boundary (→ U+FFFD replacement chars → invalid JSON on
      // large outputs like a catalog with federated sources). Buffer.concat first.
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (spawnError: Error) => {
      resolve({
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        spawnError,
        oversize,
      });
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        oversize,
      });
    });
  });
}

/** Build a synthesized fail-soft envelope carrying the cause as an ERROR. */
function bridgeError<TData = Record<string, unknown>>(
  command: string,
  message: string,
): BridgeEnvelope<TData> {
  const finding: Finding = {
    level: "ERROR",
    path: FORGE_BIN,
    line: null,
    message,
    source: "forge-bridge",
  };
  return {
    forge: "unknown",
    command,
    ok: false,
    ts: new Date().toISOString(),
    data: {} as TData,
    findings: [finding],
    summary: { errors: 1, warnings: 0, info: 0 },
    bridgeError: true,
  };
}

/** Minimal structural check that a parsed object is a C3 envelope. */
function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.command === "string" &&
    typeof v.ok === "boolean" &&
    typeof v.data === "object" &&
    Array.isArray(v.findings) &&
    typeof v.summary === "object"
  );
}

/**
 * Run a forge CLI command and return the parsed C3 envelope.
 *
 * @param cmd  command (may be a group, e.g. "registry ls" or "registry").
 * @param args additional positional/flag args (e.g. ["build", "--write"]).
 *             `--json` is always appended automatically.
 * @param opts optional overrides — `{ cwd }` to spawn in a specific dir instead
 *             of the active root (only the cwd-scoped verbs need this).
 */
export async function runForge<TData = Record<string, unknown>>(
  cmd: string,
  args: string[] = [],
  opts?: RunForgeOptions,
): Promise<BridgeEnvelope<TData>> {
  // Resolve the working directory ONCE here (runForge is async; spawnForge is
  // not): an explicit opts.cwd wins, otherwise scope to the active harness root.
  const cwd = opts?.cwd ?? (await getActiveRoot());
  const result = await spawnForge(cmd, args, { ...opts, cwd });

  if (result.spawnError) {
    return bridgeError<TData>(
      cmd,
      `Failed to spawn forge CLI: ${result.spawnError.message}`,
    );
  }

  // DEFENSIVE size guard (F11): stdout blew past MAX_STDOUT_BYTES — do NOT attempt to
  // JSON.parse a giant string. Fail soft with an actionable cause. With the CLI's
  // summarized catalog payload in place this never fires.
  if (result.oversize) {
    const mb = (MAX_STDOUT_BYTES / (1024 * 1024)).toFixed(0);
    return bridgeError<TData>(
      cmd,
      `forge ${cmd} output too large (> ${mb} MB) — payload must be trimmed.`,
    );
  }

  const raw = result.stdout.trim();
  if (!raw) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    return bridgeError<TData>(
      cmd,
      `forge ${cmd} produced no stdout (${detail}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some commands may print non-JSON lines before the envelope; try to
    // recover the last JSON object on stdout.
    const lastBrace = raw.lastIndexOf("{");
    if (lastBrace >= 0) {
      try {
        parsed = JSON.parse(raw.slice(lastBrace));
      } catch {
        return bridgeError<TData>(
          cmd,
          `forge ${cmd} returned non-JSON stdout.`,
        );
      }
    } else {
      return bridgeError<TData>(cmd, `forge ${cmd} returned non-JSON stdout.`);
    }
  }

  if (!isEnvelope(parsed)) {
    return bridgeError<TData>(
      cmd,
      `forge ${cmd} returned a payload that is not a C3 envelope.`,
    );
  }

  return parsed as BridgeEnvelope<TData>;
}
