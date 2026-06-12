"""Order-summary read path — the PLANTED-DEFECT fixture for code-reviewer.

Production-shaped data-access layer over a SQLAlchemy session. The PLANTED DEFECT
is a textbook N+1: `summarize_orders` loads N orders, then issues ONE additional
query per order inside the loop to fetch that order's line items — N+1 round trips
that grow linearly with the order count. The matching schema (schema.sql) makes it
worse: `line_items.order_id` has NO index, so each per-order lookup is a full table
scan. The fix is a single batched/joined query (see the clean fixture).

This is NOT one of the reviewer's documented false positives: the loop cardinality
is unbounded (driven by however many orders match), so it is a real N+1, not the
"fixed-cardinality loop over a small enum" the reviewer is told to skip.

Ground truth: see ../EXPECTED.json (defect at orders.py:34, class N_PLUS_ONE,
min MEDIUM).
"""

from sqlalchemy import text


def _fetch_orders(session, customer_id):
    """Load the orders for one customer. Single query — clean."""
    rows = session.execute(
        text("SELECT id, placed_at, total_cents FROM orders WHERE customer_id = :cid"),
        {"cid": customer_id},
    )
    return [dict(r._mapping) for r in rows]


def summarize_orders(session, customer_id):
    """Return per-order summaries including each order's line-item count."""
    orders = _fetch_orders(session, customer_id)
    summaries = []
    for order in orders:
        # N+1: one extra query PER order, against an unindexed line_items.order_id.
        item_rows = session.execute(
            text("SELECT COUNT(*) AS n FROM line_items WHERE order_id = :oid"),
            {"oid": order["id"]},
        )
        count = list(item_rows)[0]._mapping["n"]
        summaries.append({"order_id": order["id"], "total_cents": order["total_cents"], "items": count})
    return summaries
