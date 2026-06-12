# Forge

**A personal, self-tailoring Claude Code harness — installs once globally and tailors itself to every project.**

Forge is a Claude Code plugin: a reusable library of agents, skills, commands, rules, and hooks, plus a zero-dependency CLI and a detect-and-offer bootstrap engine that generates a tailored `.claude/` harness for any project. This repo also ships an optional local web UI for managing it.

> **Status: Beta (v0.2.0).** Executable end-to-end. Expect rough edges — feedback welcome.

## What's in this repo

| Path | What it is |
|------|------------|
| [`cli/`](./cli) | **The forge plugin** — the harness library + the `forge` CLI (zero dependencies, Node ≥18). This is what installs into Claude Code. |
| [`web/`](./web) | **Optional web UI** — a local Next.js app to browse and manage the harness (registry, dependency graph, memory, validation, multi-project birds-eye). |

## Install the plugin

In Claude Code:

```
/plugin marketplace add Im-Gonzo/forge-harness
/plugin install forge@forge
```

(`forge@forge` = the `forge` plugin from the `forge` marketplace defined in [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json).)

Then open any project. Forge notices it has no harness yet and offers **`/harness-init`**, which profiles the project and generates a tailored `.claude/`. See [`cli/README.md`](./cli/README.md) for the full workflow (`/harness-init`, `/harness-sync`, `/harness-doctor`).

### Use the CLI directly (optional)

```
cd cli
node bin/forge.mjs status      # also: validate · registry build · analyze · memory · mcp · ...
```

## Run the web UI (optional)

```
cd web
npm install
npm run dev                    # http://localhost:3000
```

By default the web app manages the sibling `../cli` plugin (override with the `FORGE_ROOT` env var). For the multi-project birds-eye view, set `FORGE_WEB_SCAN_ROOT` to the folder that holds your projects (it defaults to this repo's parent directory).

> **Keep it on localhost.** The web UI has no authentication — its mutating routes (adopt, lock, tailor, MCP enable) assume a single local operator. Don't bind it to a network interface or expose it from a shared/remote dev box.

## Requirements

- **Plugin / CLI:** Node ≥18, zero npm dependencies.
- **Web UI:** Node ≥18 (Next.js; run `npm install` in `web/`).

## License

Apache 2.0 © Gonzalo Alcala — see [LICENSE](./LICENSE).
