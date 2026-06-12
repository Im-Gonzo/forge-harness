# Orders service — overview

A small in-memory orders service used to model the order book for a handful of
tenants. The service lets each tenant place orders, look them up, list them, and
archive the ones they no longer need. An operations team also runs fleet-wide
reports and nightly exports over the whole book.

## Domains

- **Orders** — the core record: a SKU, a quantity, a status (`open` / `archived`),
  and a creation time.
- **Customers** — a light registry of who places the orders.
- **Tenants** — the businesses that share the service.

## Layout

- `src/lib/` — context, ids, clock, and the in-memory table store.
- `src/events/` — the append-only event log.
- `src/orders/` — the order store and its thin service layer.
- `src/customers/` — the customer registry.
- `src/tenants/` — the tenant registry.
- `src/legacy/` — older fleet-wide reporting and export utilities.
- `src/admin/` — operational/maintenance helpers.

See `events.md` for the event taxonomy and `glossary.md` for terms.
