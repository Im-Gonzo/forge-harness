import path from "node:path";

/**
 * Forge Web — runtime configuration.
 *
 * FORGE_ROOT is the absolute path to the forge plugin/CLI this app manages. In
 * this monorepo the web app lives at `<repo>/web` and the CLI at `<repo>/cli`, so
 * the default resolves to `../cli` relative to where Next runs (the `web/` dir,
 * i.e. `process.cwd()`). Set the FORGE_ROOT env var to manage a forge checkout
 * elsewhere.
 *
 * The forge CLI resolves `.forge/registry.json` relative to its CWD, so every
 * shell-out via the bridge MUST spawn `node <FORGE_ROOT>/bin/forge.mjs` with
 * `cwd: FORGE_ROOT` — otherwise the CLI returns no data.
 */
export const FORGE_ROOT =
  process.env.FORGE_ROOT ?? path.resolve(process.cwd(), "..", "cli");

/** Absolute path to the forge CLI entrypoint. */
export const FORGE_BIN = `${FORGE_ROOT}/bin/forge.mjs`;
