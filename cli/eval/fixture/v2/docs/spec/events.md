# Event taxonomy

Events are appended to `events.log` as JSONL, one line per event. Each line carries
a timestamp, the acting `tenantId`, a dotted `type`, and a small `payload`.

| type | when |
|---|---|
| `order.created` | a new order is placed |
| `order.updated` | an order's fields change |
| `order.archived` | an order is moved to the `archived` status |
| `customer.added` | a customer is registered |

New verbs follow the same `order.<verb>` shape. The archive verb is `order.archived`.
