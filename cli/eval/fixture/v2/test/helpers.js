import { _resetStore } from '../src/lib/store.js';
import { _resetIds } from '../src/lib/ids.js';
import { _resetEvents, readEvents } from '../src/events/emit.js';
import { _freeze, _unfreeze, days } from '../src/lib/clock.js';
import { seedTenants } from '../src/tenants/registry.js';

/** Reset all in-memory state + the events log to a clean, seeded baseline. */
export function resetWorld() {
  _resetStore();
  _resetIds();
  _resetEvents();
  _unfreeze();
  seedTenants();
}

export { readEvents, _freeze, days };
