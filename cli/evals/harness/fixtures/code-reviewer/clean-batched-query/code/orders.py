"""Order-summary read path — the CLEAN trap for code-reviewer.

This file deliberately *resembles* the N+1 fixture (a loop over orders that needs
each order's line-item count) but is CORRECT: the counts are fetched in ONE batched
`GROUP BY` query BEFORE the loop, so the loop does zero database work. It also plants
the exact false positive the reviewer is told to skip: a `for status in OrderStatus`
loop over a small fixed enum, which is NOT an N+1 ("N+1 query on a fixed-cardinality
loop (iterating a small enum) or a path already batching" — do NOT report). A correct
review of this file returns ZERO findings.

Ground truth: see ../EXPECTED.json — empty defects[], the resemblances marked as
clean_traps[] the reviewer must stay silent on.
"""

from enum import Enum

from sqlalchemy import text


class OrderStatus(str, Enum):
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"


def _fetch_orders(session, customer_id):
    rows = session.execute(
        text("SELECT id, total_cents FROM orders WHERE customer_id = :cid"),
        {"cid": customer_id},
    )
    return [dict(r._mapping) for r in rows]


def _batch_item_counts(session, customer_id):
    """ONE query: counts for ALL of the customer's orders, grouped. No N+1."""
    rows = session.execute(
        text(
            "SELECT li.order_id AS oid, COUNT(*) AS n "
            "FROM line_items li JOIN orders o ON o.id = li.order_id "
            "WHERE o.customer_id = :cid GROUP BY li.order_id"
        ),
        {"cid": customer_id},
    )
    return {r._mapping["oid"]: r._mapping["n"] for r in rows}


def summarize_orders(session, customer_id):
    """Return per-order summaries — all DB work done in two queries, total."""
    orders = _fetch_orders(session, customer_id)
    counts = _batch_item_counts(session, customer_id)  # batched ONCE, before the loop
    summaries = []
    for order in orders:
        # Pure dict lookup — NO database call in the loop body. Not an N+1.
        summaries.append({"order_id": order["id"], "items": counts.get(order["id"], 0)})
    return summaries


def status_labels():
    """Build display labels for each status. Fixed-cardinality loop over a small
    enum — the reviewer's documented do-NOT-report N+1 false positive."""
    labels = {}
    for status in OrderStatus:
        labels[status.value] = status.name.title()
    return labels
