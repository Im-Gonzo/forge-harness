-- Schema for the order-summary read path (planted-defect fixture).
-- The PLANTED DEFECT here is the MISSING INDEX on line_items.order_id: the N+1
-- read path in orders.py filters `WHERE order_id = :oid` on every iteration, and
-- with no index that filter is a full table scan each time. The fix is one index
-- (see the clean fixture's schema.sql, which has it).

CREATE TABLE orders (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL,
    placed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_cents  BIGINT NOT NULL
);

-- orders.customer_id IS indexed — the customer lookup is fine (clean line).
CREATE INDEX idx_orders_customer ON orders (customer_id);

CREATE TABLE line_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT NOT NULL REFERENCES orders (id),
    sku        TEXT NOT NULL,
    qty        INTEGER NOT NULL
);
-- MISSING INDEX: line_items.order_id is the hot filter column in orders.py but
-- has no supporting index, so each per-order COUNT(*) scans the whole table.
