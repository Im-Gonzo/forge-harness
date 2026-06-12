/**
 * POST /api/graph-edit — the editable write surface for both graphs.
 *
 * Two focused action families (NOT a freeform node editor):
 *
 *  1. resolve-dangling — fix a dangling reference in its source file(s):
 *       { kind: "resolve-dangling", rawRef, sites, op: "remove" }
 *       { kind: "resolve-dangling", rawRef, sites, op: "redirect", toId }
 *
 *  2. manifest-edit — assign/remove in the composition manifests:
 *       { kind: "manifest-edit", op: "add-module-to-profile",   profile, module }
 *       { kind: "manifest-edit", op: "remove-module-from-profile", profile, module }
 *       { kind: "manifest-edit", op: "add-component-to-module", module, componentKind, component }
 *       { kind: "manifest-edit", op: "remove-component-from-module", module, componentKind, component }
 *
 * Every action runs the additive write cycle (write → validate → registry
 * build --write). The response carries {ok, findings, validate/registry
 * envelopes} so the client can surface validate findings inline; advisory
 * WARNs do not block (ADR-0007). On success the client refetches to re-render.
 */
import {
  resolveDanglingRef,
  modifyManifestArray,
  deleteManifestProperty,
  writeManifest,
  readManifest,
  type DanglingSite,
  type ProfilesManifest,
  type ModulesManifest,
} from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

type Body =
  | {
      kind: "resolve-dangling";
      rawRef: string;
      sites: DanglingSite[];
      op: "remove" | "redirect";
      toId?: string;
    }
  | {
      kind: "manifest-edit";
      op: "add-module-to-profile" | "remove-module-from-profile";
      profile: string;
      module: string;
    }
  | {
      kind: "manifest-edit";
      op: "add-component-to-module" | "remove-component-from-module";
      module: string;
      componentKind: string;
      component: string;
    };

function bad(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  if (!body || typeof body !== "object" || !("kind" in body)) {
    return bad("Missing 'kind'.");
  }

  try {
    if (body.kind === "resolve-dangling") {
      return await handleResolveDangling(body);
    }
    if (body.kind === "manifest-edit") {
      return await handleManifestEdit(body);
    }
    return bad(`Unknown action kind: ${(body as { kind?: string }).kind}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// resolve-dangling
// ──────────────────────────────────────────────────────────────────────────

async function handleResolveDangling(
  body: Extract<Body, { kind: "resolve-dangling" }>,
): Promise<Response> {
  const { rawRef, sites, op, toId } = body;
  if (!rawRef || !Array.isArray(sites) || sites.length === 0) {
    return bad("resolve-dangling requires 'rawRef' and non-empty 'sites'.");
  }
  if (op !== "remove" && op !== "redirect") {
    return bad("resolve-dangling 'op' must be 'remove' or 'redirect'.");
  }
  if (op === "redirect" && (!toId || toId.length === 0)) {
    return bad("redirect requires a non-empty 'toId'.");
  }

  const result = await resolveDanglingRef({
    rawRef,
    sites,
    action: op,
    toId,
  });

  return Response.json(
    {
      ok: result.ok,
      edited: result.edited,
      findings: result.findings,
      validate: result.validateResult,
      registry: result.registryResult,
    },
    { status: result.ok ? 200 : 200 }, // WARN-only validate is still a 200 (non-blocking)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// manifest-edit
// ──────────────────────────────────────────────────────────────────────────

async function handleManifestEdit(
  body: Extract<Body, { kind: "manifest-edit" }>,
): Promise<Response> {
  if (
    body.op === "add-module-to-profile" ||
    body.op === "remove-module-from-profile"
  ) {
    const { profile, module } = body;
    if (!profile || !module) {
      return bad("module-to-profile ops require 'profile' and 'module'.");
    }
    const profiles = await readManifest<ProfilesManifest>("profiles");
    const target = profiles.profiles?.[profile];
    if (!target) return bad(`Unknown profile: ${profile}`);
    const current = Array.isArray(target.modules) ? target.modules : [];

    // Guard against a bad manifest before touching disk (validate-manifests
    // enforces the same; we fail fast with a clearer error).
    if (body.op === "add-module-to-profile") {
      const modules = await readManifest<ModulesManifest>("modules");
      if (!modules.modules?.[module]) {
        return bad(`Unknown module (not in modules.json): ${module}`);
      }
      if (current.includes(module)) {
        return bad(`Profile '${profile}' already includes module '${module}'.`);
      }
    } else if (!current.includes(module)) {
      return bad(`Profile '${profile}' does not include module '${module}'.`);
    }

    // MINIMAL-DIFF write: splice only this profile's `modules` array, leaving
    // every other line (incl. other profiles' hand-wrapped arrays) byte-identical.
    const op = body.op === "add-module-to-profile" ? "add" : "remove";
    const result = await modifyManifestArray(
      "profiles",
      ["profiles", profile, "modules"],
      op,
      module,
    );
    return manifestResponse(result, { profile, module, op: body.op });
  }

  if (
    body.op === "add-component-to-module" ||
    body.op === "remove-component-from-module"
  ) {
    const { module, componentKind, component } = body;
    if (!module || !componentKind || !component) {
      return bad(
        "component-to-module ops require 'module', 'componentKind', and 'component'.",
      );
    }
    const modules = await readManifest<ModulesManifest>("modules");
    const target = modules.modules?.[module];
    if (!target) return bad(`Unknown module: ${module}`);
    if (!modules.componentKinds?.includes(componentKind)) {
      return bad(`Unknown component kind: ${componentKind}`);
    }
    const hasKind = Boolean(target.components?.[componentKind]);
    const list = Array.isArray(target.components?.[componentKind])
      ? target.components![componentKind]
      : [];

    let result;
    if (body.op === "add-component-to-module") {
      if (list.includes(component)) {
        return bad(
          `Module '${module}' already lists '${component}' under '${componentKind}'.`,
        );
      }
      if (hasKind) {
        // MINIMAL-DIFF: splice into the existing kind array in place.
        result = await modifyManifestArray(
          "modules",
          ["modules", module, "components", componentKind],
          "add",
          component,
        );
      } else {
        // The kind key does not exist yet — there is no array to splice. Fall
        // back to the whole-object write to introduce it (rare; a new kind on a
        // module). Read-modify-write the parsed object.
        if (!target.components) target.components = {};
        target.components[componentKind] = [component];
        result = await writeManifest("modules", modules);
      }
    } else {
      if (!list.includes(component)) {
        return bad(
          `Module '${module}' does not list '${component}' under '${componentKind}'.`,
        );
      }
      if (list.length === 1) {
        // Last component of this kind — drop the whole kind key (prior behaviour
        // deleted the key rather than leaving an empty array), minimal-diff.
        result = await deleteManifestProperty("modules", [
          "modules",
          module,
          "components",
          componentKind,
        ]);
      } else {
        result = await modifyManifestArray(
          "modules",
          ["modules", module, "components", componentKind],
          "remove",
          component,
        );
      }
    }

    return manifestResponse(result, {
      module,
      componentKind,
      component,
      op: body.op,
    });
  }

  return bad(`Unknown manifest-edit op: ${(body as { op?: string }).op}`);
}

function manifestResponse(
  result: {
    ok: boolean;
    findings: unknown[];
    validateResult: unknown;
    registryResult: unknown;
  },
  echo: Record<string, unknown>,
): Response {
  return Response.json(
    {
      ok: result.ok,
      ...echo,
      findings: result.findings,
      validate: result.validateResult,
      registry: result.registryResult,
    },
    { status: 200 },
  );
}
