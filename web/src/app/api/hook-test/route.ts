/**
 * /api/hook-test — the HOOK lifecycle board's server surface.
 *
 * Hooks are matcher-groups inside a SHARED JSON file (hooks/hooks.json), so they
 * are deliberately NOT writable through the generic resource CRUD route
 * (writeResource throws for kind "hook"). This route is their dedicated,
 * hook-aware surface. It owns four POST actions (discriminated by `action`):
 *
 *   • "read"        — the board model: hooks.json flattened into event columns +
 *                     the raw JSON text, and (optionally, by `id`) one hook's
 *                     `.mjs` source so the editor can open Monaco.
 *   • "edit-field"  — MINIMAL-DIFF edit of ONE hook field (timeout / matcher /
 *                     command / id / description) via jsonc-parser, then the
 *                     bridge write cycle (validate → registry build --write).
 *   • "save-mjs"    — write a hook's `.mjs` body, then the same write cycle.
 *   • "test"        — pipe a SAMPLE stdin payload to the hook's script and report
 *                     its allow/deny verdict. READ-ONLY: it spawns the script in a
 *                     child process and NEVER touches hooks.json or any file.
 *
 * Edits + saves run the EXACT bridge cycle the rest of Forge Web uses (write →
 * `forge validate` → `forge registry build --write`); advisory WARNs are
 * returned, never thrown (ADR-0007). "test" is mutation-free by construction.
 *
 * Server-only: node:fs / node:child_process / the forge bridge.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { FORGE_ROOT } from "@/lib/config";
import { runForge } from "@/lib/forge-bridge";
import type { Finding } from "@/lib/types";
import {
  HOOK_EVENTS,
  flattenHooks,
  findHookLocation,
  editHookField,
  resolveHookScript,
  interpretHookResult,
} from "./hook-edit-core.mjs";

export const dynamic = "force-dynamic";

const HOOKS_REL = "hooks/hooks.json";
const HOOKS_ABS = path.join(FORGE_ROOT, HOOKS_REL);

/** Fields the board may edit (mirrors hook-edit-core's allow-lists). */
const EDITABLE_FIELDS = new Set([
  "matcher",
  "description",
  "id",
  "command",
  "timeout",
  "async",
]);

/** A `.mjs` body may not escape the repo's hooks/ tree (path-traversal guard). */
function safeHookScriptAbs(rel: string): string | null {
  const abs = path.resolve(FORGE_ROOT, rel);
  const hooksDir = path.resolve(FORGE_ROOT, "hooks");
  if (abs !== hooksDir && !abs.startsWith(hooksDir + path.sep)) return null;
  if (!abs.endsWith(".mjs")) return null;
  return abs;
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

async function readHooksText(): Promise<string> {
  return fs.readFile(HOOKS_ABS, "utf8");
}

// ──────────────────────────────────────────────────────────────────────────
// Sample stdin presets — the payloads the board can pipe to a hook.
// Each is a Claude Code PreToolUse-style payload; `planted-secret` is the one
// that MUST make secret-scan emit a DENY (an AWS access key in file content).
// ──────────────────────────────────────────────────────────────────────────

const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
  "clean-write": {
    session_id: "hook-board-sample",
    tool_name: "Write",
    tool_input: {
      file_path: "src/example.ts",
      content: "export const greeting = 'hello world';\n",
    },
  },
  "planted-secret": {
    session_id: "hook-board-sample",
    tool_name: "Write",
    tool_input: {
      file_path: "src/config.ts",
      // A real-shaped AWS access key id — secret-scan must DENY this.
      content: "export const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';\n",
    },
  },
  "no-verify-bash": {
    session_id: "hook-board-sample",
    tool_name: "Bash",
    tool_input: { command: "git commit --no-verify -m 'skip hooks'" },
  },
  "session-start": {
    session_id: "hook-board-sample",
    hook_event_name: "SessionStart",
    source: "startup",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// POST router
// ──────────────────────────────────────────────────────────────────────────

interface Body {
  action?: "read" | "edit-field" | "save-mjs" | "test";
  id?: string;
  field?: string;
  value?: string | number | boolean | null;
  scriptRel?: string;
  source?: string;
  payloadKey?: string;
  payload?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || !body.action) {
    return bad("Missing 'action'.");
  }

  try {
    switch (body.action) {
      case "read":
        return await handleRead(body);
      case "edit-field":
        return await handleEditField(body);
      case "save-mjs":
        return await handleSaveMjs(body);
      case "test":
        return await handleTest(body);
      default:
        return bad(`Unknown action: ${String(body.action)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// read — board model (+ a hook's mjs source when `id` is given)
// ──────────────────────────────────────────────────────────────────────────

async function handleRead(body: Body): Promise<Response> {
  const text = await readHooksText();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return bad(
      `hooks.json is not valid JSON: ${e instanceof Error ? e.message : e}`,
      500,
    );
  }
  const flat = flattenHooks(parsed);

  // Project the board: serializable cards (no functions), grouped by event.
  const board = flat.map((h) => {
    const cmd = Array.isArray(h.group.hooks) ? h.group.hooks[0] : undefined;
    const script = cmd
      ? resolveHookScript(cmd.command, FORGE_ROOT, path.join)
      : null;
    return {
      id: h.id,
      event: h.event,
      index: h.index,
      matcher: h.group.matcher ?? "",
      description: h.group.description ?? "",
      command: cmd?.command ?? "",
      timeout: typeof cmd?.timeout === "number" ? cmd.timeout : null,
      async: cmd?.async === true,
      scriptRel: script?.rel ?? null,
    };
  });

  // Optionally include one hook's mjs source (for the Monaco panel).
  let mjs: { rel: string; source: string } | null = null;
  if (body.id) {
    const loc = findHookLocation(parsed, body.id);
    const cmd = loc?.group?.hooks?.[0];
    const script = cmd
      ? resolveHookScript(cmd.command, FORGE_ROOT, path.join)
      : null;
    if (script) {
      const abs = safeHookScriptAbs(script.rel);
      if (abs) {
        try {
          mjs = { rel: script.rel, source: await fs.readFile(abs, "utf8") };
        } catch {
          mjs = { rel: script.rel, source: "" };
        }
      }
    }
  }

  return Response.json(
    { ok: true, events: HOOK_EVENTS, board, hooksText: text, mjs },
    { status: 200 },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// edit-field — minimal-diff JSON edit + bridge write cycle
// ──────────────────────────────────────────────────────────────────────────

async function handleEditField(body: Body): Promise<Response> {
  const { id, field } = body;
  if (!id) return bad("edit-field requires 'id'.");
  if (!field || !EDITABLE_FIELDS.has(field)) {
    return bad(`edit-field 'field' must be one of: ${[...EDITABLE_FIELDS].join(", ")}.`);
  }
  // Coerce `timeout` to a finite number; reject negatives (schema: minimum 0).
  let value: string | number | boolean | undefined =
    body.value === null ? undefined : (body.value as string | number | boolean);
  if (field === "timeout" && value !== undefined) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      return bad("timeout must be a number ≥ 0.");
    }
    value = n;
  }
  if (field === "async" && value !== undefined) {
    value = value === true || value === "true";
  }

  const before = await readHooksText();
  let after: string;
  try {
    after = editHookField(before, id, field, value);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }

  if (after !== before) {
    await fs.writeFile(HOOKS_ABS, after, "utf8");
  }

  const cycle = await runWriteCycle();
  return Response.json(
    { ok: cycle.ok, changed: after !== before, findings: cycle.findings, ...cycle.envelopes },
    { status: 200 },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// save-mjs — write a hook's .mjs body + bridge write cycle
// ──────────────────────────────────────────────────────────────────────────

async function handleSaveMjs(body: Body): Promise<Response> {
  const { scriptRel, source } = body;
  if (!scriptRel) return bad("save-mjs requires 'scriptRel'.");
  if (typeof source !== "string") return bad("save-mjs requires a string 'source'.");
  const abs = safeHookScriptAbs(scriptRel);
  if (!abs) return bad(`Refusing to write outside hooks/*.mjs: ${scriptRel}`);

  await fs.writeFile(abs, source, "utf8");

  const cycle = await runWriteCycle();
  return Response.json(
    { ok: cycle.ok, findings: cycle.findings, ...cycle.envelopes },
    { status: 200 },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// test — pipe sample stdin to a hook script; report allow/deny. NO mutation.
// ──────────────────────────────────────────────────────────────────────────

async function handleTest(body: Body): Promise<Response> {
  const { id } = body;
  if (!id) return bad("test requires 'id'.");

  const text = await readHooksText();
  const parsed = JSON.parse(text);
  const loc = findHookLocation(parsed, id);
  if (!loc) return bad(`No hook group with id '${id}'.`, 404);
  const cmd = loc.group?.hooks?.[0];
  if (!cmd || typeof cmd.command !== "string") {
    return bad(`Hook '${id}' has no runnable command.`);
  }
  const script = resolveHookScript(cmd.command, FORGE_ROOT, path.join);
  if (!script) {
    return bad(`Cannot resolve a script path from command: ${cmd.command}`);
  }
  const abs = safeHookScriptAbs(script.rel);
  if (!abs) return bad(`Resolved script escapes hooks/: ${script.rel}`);

  // Resolve the sample payload (a named preset, or a caller-supplied object).
  let payload: Record<string, unknown> | undefined;
  if (body.payload && typeof body.payload === "object") {
    payload = body.payload as Record<string, unknown>;
  } else {
    const key = body.payloadKey ?? "clean-write";
    payload = SAMPLE_PAYLOADS[key];
    if (!payload) {
      return bad(
        `Unknown payloadKey '${key}'. Known: ${Object.keys(SAMPLE_PAYLOADS).join(", ")}.`,
      );
    }
  }

  const run = await spawnHook(abs, JSON.stringify(payload));
  const verdict = interpretHookResult(run.stdout, run.code);

  return Response.json(
    {
      ok: true,
      id,
      scriptRel: script.rel,
      payloadKey: body.payload ? "custom" : (body.payloadKey ?? "clean-write"),
      verdict: verdict.verdict, // "deny" | "allow" | "error"
      reason: verdict.reason,
      exitCode: run.code,
      stdout: run.stdout,
      stderr: run.stderr,
    },
    { status: 200 },
  );
}

/** Spawn a hook script with `payloadJson` on stdin; capture stdout/stderr/exit. */
function spawnHook(
  scriptAbs: string,
  payloadJson: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptAbs], {
      cwd: FORGE_ROOT,
      // Provide CLAUDE_PLUGIN_ROOT so a hook that re-derives its own paths resolves
      // against the real repo. The test never writes, so this is read-only.
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: FORGE_ROOT },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e: Error) => {
      stderr += `\n[spawn error] ${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    // Hooks must not hang the request — bound the run at 10s.
    const timer = setTimeout(() => {
      stderr += "\n[hook-test] timed out after 10s; killed.";
      child.kill("SIGKILL");
      finish(null);
    }, 10_000);
    timer.unref?.();
    child.stdin.on("error", () => {
      /* ignore EPIPE if the hook exits before reading all of stdin */
    });
    child.stdin.write(payloadJson);
    child.stdin.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Shared write cycle — the EXACT bridge cycle (validate → registry build).
// ──────────────────────────────────────────────────────────────────────────

async function runWriteCycle(): Promise<{
  ok: boolean;
  findings: Finding[];
  envelopes: { validate: unknown; registry: unknown };
}> {
  const validate = await runForge("validate");
  const registry = await runForge("registry", ["build", "--write"]);
  const findings = validate.findings ?? [];
  const ok = (validate.summary?.errors ?? 0) === 0;
  return { ok, findings, envelopes: { validate, registry } };
}
