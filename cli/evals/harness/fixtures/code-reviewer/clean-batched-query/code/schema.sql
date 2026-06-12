-- Schema for the CLEAN batched read path. Unlike the planted-defect fixture, the
-- hot filter column line_items.order_id IS indexed here, so the batched GROUP BY
-- in orders.py is index-supported. A correct review flags NOTHING in this file.

CREATE TABLE orders (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL,
    placed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_cents  BIGINT NOT NULL
);

CREATE INDEX idx_orders_customer ON orders (customer_id);

CREATE TABLE line_items (
    id         BIGSERIAL PRIMARY KEY,
    order_id   BIGINT NOT NULL REFERENCES orders (id),
    sku        TEXT NOT NULL,
    qty        INTEGER NOT NULL
);

-- The index the planted-defect fixture is MISSING — present and correct here.
CREATE INDEX idx_line_items_order ON line_items (order_id);
