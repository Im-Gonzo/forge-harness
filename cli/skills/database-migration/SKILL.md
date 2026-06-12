---
name: database-migration
description: The safe-migration procedure for Postgres. Plan a schema change as expand → migrate → contract; add columns/indexes without a table rewrite (CONCURRENTLY, NOT VALID + VALIDATE); backfill in committed batches; carry tenancy/RLS; write a reversible migration with a stated rollback plan; prove timing on prod-sized data. Alembic-flavored but tool-general.
---

# database-migration — change a Postgres schema without downtime

A schema change is the canonical **T2** task (`docs/METHOD.md` §3): the draft is autonomous, the
**apply is human-gated**. This skill is the procedure that produces a draft a human can confidently
apply, and that the `database-reviewer` agent can gate. It is Alembic-flavored but the phases hold for
any migration tool (Django, golang-migrate, Prisma custom SQL, Drizzle, Kysely).

> Single source of truth: the *rules* live in the `migrations` rule (`rules/migrations.md`). This skill
> is the *how*; that rule is the *must*. Don't restate it — follow it.

## When to activate

- Adding, renaming, dropping, or retyping a column or table on a database with live traffic.
- Adding an index or a constraint (`NOT NULL`, `CHECK`, `FOREIGN KEY`, `UNIQUE`) to a populated table.
- Backfilling or transforming existing rows.
- Standing up a new tenant-scoped table (must inherit the RLS/tenancy contract).
- Any change where "it worked on my 100-row dev DB" is not evidence it is safe on production.

## How it works

### Phase 0 — Classify and plan (read-only)

1. **Size the blast radius.** How many rows? Is the table hot (high write QPS)? What locks does the raw
   statement take? A change that is instant on a cold 1k-row table can hold `ACCESS EXCLUSIVE` for
   minutes on a 50M-row hot one.
2. **Decide if it is expand-contract.** Renames, drops, type changes, and `NOT NULL`-on-populated all
   require the multi-deploy dance below — they cannot be a single in-place statement without breaking
   running code. A plain nullable-column add or a `CONCURRENTLY` index does not.
3. **Write the rollback plan first.** What does `down` do? If the change is destructive (drops data),
   say so explicitly and record the recovery path (restore-from-backup) — don't pretend it reverses.

### Phase 1 — EXPAND (additive, deployable alone)

Add the new shape alongside the old; nothing reads it yet. This migration must be safe to deploy with
the *old* application still running.

```sql
-- New column: nullable (or constant default — metadata-only on PG 11+). No NOT NULL yet.
ALTER TABLE users ADD COLUMN email_normalized text;

-- New index: CONCURRENTLY, in its OWN migration (cannot run in a txn block).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_normalized
  ON users (email_normalized);
```

In Alembic, the concurrent index needs the transaction disabled for that revision:

```python
# alembic revision — concurrent build cannot run inside the migration's transaction
def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_normalized "
            "ON users (email_normalized)"
        )
```

Then deploy app code that **dual-writes** (writes both `email` and `email_normalized`) so new rows are
already correct while the backfill runs.

### Phase 2 — MIGRATE (backfill in batches, then validate)

Backfill existing rows in committed batches — never one giant `UPDATE` (it locks rows and bloats WAL).
Bound each batch and commit between them:

```sql
-- Batched backfill: bounded slice, FOR UPDATE SKIP LOCKED, commit per loop.
DO $$
DECLARE
  rows_updated int;
BEGIN
  LOOP
    UPDATE users SET email_normalized = lower(email)
    WHERE id IN (
      SELECT id FROM users
      WHERE email_normalized IS NULL
      ORDER BY id
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    COMMIT;                       -- release locks each batch; throttle if replicas lag
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;
```

(In Alembic/Django, run the equivalent loop in the data migration's Python body so each batch commits;
keep the data migration as a *separate revision* from the schema one.)

Then add any constraint **without** a full-table lock — validate in two steps:

```sql
-- 1) Cheap: records the constraint, does NOT scan existing rows.
ALTER TABLE users ADD CONSTRAINT users_email_normalized_nn
  CHECK (email_normalized IS NOT NULL) NOT VALID;
-- 2) Scans under SHARE UPDATE EXCLUSIVE (concurrent reads/writes continue).
ALTER TABLE users VALIDATE CONSTRAINT users_email_normalized_nn;
```

Now deploy app code that **reads from new, still writes both**, and verify consistency between old and
new before cutting over.

### Phase 3 — CONTRACT (remove the old shape, last deploy)

Only after the new column is fully backfilled, validated, and read-from in production: deploy app code
that uses **new only**, then in a *later* migration drop the old shape.

```sql
ALTER TABLE users DROP COLUMN email;     -- old app code is gone; nothing references it
```

Never drop before the no-references deploy has shipped — the old code errors the instant the column
disappears.

### Phase 4 — Prove it (evidence before claims)

`docs/METHOD.md` §4: do not call a migration "safe" from reading it.

```bash
alembic upgrade head --sql > /tmp/plan.sql   # review the exact SQL that will run
# Apply against a production-SIZED copy, capture timing + locks taken:
\timing on
EXPLAIN (ANALYZE, BUFFERS) <the heavy statement>;
SELECT relation::regclass, mode FROM pg_locks WHERE granted;   -- during the run
alembic current && alembic heads            # confirm single head, no drift
```

Quote the real timing and lock modes in the handoff. A migration that passed on 100 rows can lock for
minutes on 10M.

### Tenancy / RLS for a new table (don't drop the invisible 20%)

A new tenant-scoped table inherits the project's isolation contract — match the constitution's
invariants, don't invent your own:

```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;            -- applies to the table owner too
CREATE POLICY tenant_isolation ON notes
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE INDEX CONCURRENTLY idx_notes_tenant ON notes (tenant_id);  -- the policy predicate
```

Set the tenant GUC transaction-locally so it cannot leak across pooled connections under
transaction-mode pooling: `SET LOCAL app.tenant_id = '...'`. Run migrations under the audited,
least-privilege migration role, not the app's runtime role.

## Anti-patterns

| PASS | FAIL |
|---|---|
| Add column nullable, backfill in batches, `ADD CONSTRAINT ... NOT VALID` then `VALIDATE` | `ADD COLUMN ... NOT NULL` (no default) on a populated table — `ACCESS EXCLUSIVE` lock + full rewrite |
| `CREATE INDEX CONCURRENTLY` in its own revision with the txn disabled | Plain `CREATE INDEX` on a hot table — blocks all writes for the whole build |
| Backfill loop committing per bounded batch | One `UPDATE users SET ...` over the whole table — long lock, WAL bloat, replica lag |
| Schema change and data backfill as separate revisions | DDL + a big `UPDATE` in one migration — long-held locks, painful to roll back |
| Expand → dual-write → backfill → cut reads → drop in a later deploy | `ALTER ... RENAME` / `DROP COLUMN` while old app code still references it — instant errors |
| New tenant table: `ENABLE` + `FORCE` RLS, tenant policy, indexed tenant key | Tenant table shipped without RLS / with an unindexed policy predicate — cross-tenant read or per-query scan |
| `down`/reverse present, or "irreversible because X, recover via Y" stated | No reverse and no note — silent one-way migration |
| Applied against a prod-sized copy; timing + `pg_locks` quoted | "Looks fine" / verified only on the 100-row dev DB |

## Related

- `rules/migrations.md` — the normative migration-safety rules (the *must* behind this *how*).
- `agents/database-reviewer.md` — read-only reviewer that gates the drafted migration before apply.
- `rules/common/evidence-before-claims.md` — why Phase 4's fresh timing/lock proof is mandatory.
- `docs/METHOD.md` §3 (autonomy ladder, T2 split) and §4 (evidence before claims).
