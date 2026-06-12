# Glossary

- **Order book** — the full set of orders across all tenants, as stored in the
  `orders` table.
- **Acting tenant** — the tenant a request runs as, carried on `ctx.tenantId`.
- **Open order** — an order in the `open` status; the default on creation.
- **Archived order** — an order moved to the `archived` status; it stays in the book
  but is excluded from the active working set.
- **Fleet-wide report** — an operations roll-up over the whole order book.
- **Event** — an append-only record of something that happened, written to
  `events.log`.
- **SKU** — the stock-keeping unit identifying what was ordered.
