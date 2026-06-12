---
name: migrations
description: Migration safety for Postgres schema changes. Every change is a reviewed, reversible migration file; large tables get expand-contract + CONCURRENTLY + batched backfills; NOT NULL / locks / data-loss are gated. T2 by default — migrations are split autonomous-draft + human-apply.
paths: ["**/migrations/**", "**/*.sql", "**/alembic/**"]
---
# Migration Safety

> Scoped to migration files (`migrations/`, `alembic/`, `*.sql`). A schema change in
> production is **T2** by default (`docs/METHOD.md` §3): irreversible / data-bearing, so the
> draft is autonomous but the apply is human-gated. Pair with the `database-migration` skill
> (the procedure) and the `database-reviewer` agent (the gate).

## Every change is a migration file — never touch prod by hand

- [ ] All DDL/DML goes through a tracked, version-controlled migration. No manual `psql`
      against a production database; no out-of-band schema edits.
- [ ] A migration that has run in any shared environment is **immutable**. To change it,
      write a NEW forward migration — never edit one that has already applied (editing causes
      drift between environments and a checksum/`alembic heads` mismatch).
- [ ] Production rollback is a new forward migration, not a re-run of `down`. Treat `down`
      as a dev convenience; do not rely on it to undo a deployed change.

## Separate schema from data; keep transactions short

- [ ] Do NOT mix DDL (schema) and DML (backfill) in one migration. A long backfill inside a
      schema migration holds locks and is hard to roll back — split them into separate revisions.
- [ ] A bulk `UPDATE`/`DELETE` over a large table in one transaction locks rows and bloats
      WAL. Backfill in **batches** (bounded by PK range or `LIMIT ... FOR UPDATE SKIP LOCKED`),
      committing per batch. See the `database-migration` skill for the batched-backfill loop.
- [ ] Never hold a transaction open across an external call (HTTP, queue, sleep). Locks held
      that long stall every concurrent writer.

## Adding columns / constraints without a table rewrite

- [ ] Adding `NOT NULL` with no default on a populated table rewrites every row under an
      `ACCESS EXCLUSIVE` lock. Instead: add the column nullable → backfill in batches → add the
      constraint as `NOT VALID`, then `VALIDATE CONSTRAINT` (which takes only a `SHARE UPDATE
      EXCLUSIVE` lock). On Postgres 11+ a column with a *constant* default is metadata-only and
      safe; a volatile default still rewrites.
- [ ] Add `CHECK` and `FOREIGN KEY` constraints as `NOT VALID` first, then `VALIDATE
      CONSTRAINT` in a separate step so existing rows are checked without blocking writes.
- [ ] Index a foreign key's referencing column — an unindexed FK turns parent deletes/updates
      into sequential scans and escalates locking.

## Locks, indexes, and timeouts

- [ ] Build/drop indexes on existing tables with `CREATE INDEX CONCURRENTLY` /
      `DROP INDEX CONCURRENTLY`. A plain `CREATE INDEX` blocks writes for the whole build.
- [ ] `CONCURRENTLY` cannot run inside a transaction block — give it its own migration and,
      in Alembic, disable the per-migration transaction (`with op.get_context().autocommit_block():`
      or `transaction_per_migration` off). A failed concurrent build leaves an `INVALID` index;
      drop it before retrying.
- [ ] Set a bounded `lock_timeout` (and `statement_timeout`) for migrations that take
      `ACCESS EXCLUSIVE` locks, so a blocked DDL fails fast instead of queueing behind a long
      read and freezing the table. Avoid taking strong locks during peak traffic.

## Renames, drops, and type changes go through expand-contract

- [ ] Never rename or drop a column/table that running application code still references —
      the old code errors the instant the column disappears. Use **expand → migrate → contract**:
      add the new shape, dual-write, backfill, cut reads over, then drop the old shape in a
      later deploy (procedure in the `database-migration` skill).
- [ ] An in-place type change (`ALTER COLUMN ... TYPE`) can rewrite the table and break the
      wire format for in-flight code. Prefer add-new-column + backfill + swap.

## Tenancy, RLS, and least privilege (carry the project invariants)

- [ ] A new tenant-scoped table inherits the project's isolation contract: enable **and
      FORCE** Row-Level Security, add the tenant policy, and index the tenant key the policy
      filters on (an unindexed RLS predicate forces a scan per query). Match the constitution's
      invariants — do not ship a tenant table that is readable across tenants.
- [ ] Migrations that rely on a tenant GUC must set it transaction-locally
      (`SET LOCAL app.tenant_id = ...`) — a bare `SET` leaks across pooled connections under
      transaction-mode pooling.
- [ ] Run migrations under an audited, least-privilege migration role distinct from the
      application's runtime role. Do not `GRANT ALL`; grant only what the runtime role needs.

## Reversibility and verification

- [ ] Every migration has a `down`/reverse OR is explicitly annotated irreversible with the
      reason and the operational recovery plan (e.g. restore-from-backup). A silent missing
      reverse is a defect.
- [ ] State the rollback plan for the change in the migration or its PR: what `down` does, or —
      for a destructive change — why it is irreversible and how to recover.
- [ ] `docs/METHOD.md` §4 — do not claim a migration is safe from reading it. Prove it: run
      it against a production-sized copy, capture timing and the locks taken
      (`EXPLAIN`, `pg_locks`), and quote the result. A migration that passes on 100 rows can
      lock for minutes on 10M.
