---
name: review-changes
description: Example workflow — fan out a review over the current diff, then verify each finding before reporting.
phases: [find, verify]
---

# review-changes (example workflow)

A minimal, illustrative reusable workflow showing the shape of a `workflows/<name>.md`
component. It is an EXAMPLE only — wire it to a real Workflow-tool script via an
optional sibling `workflows/review-changes.js` if you want it executable.

## find

Collect the current change set (the working-tree diff) and fan out review attention
across the touched files. Each touched area is examined independently for correctness
bugs and for reuse / simplification / efficiency cleanups, so coverage scales with the
size of the diff rather than serializing through one pass.

## verify

Before anything is reported, every candidate finding is re-checked against the actual
code: a finding only survives if it points at a real line and a real defect. Verified
findings are then collated into a single, deduplicated report; unverifiable ones are
dropped. The result is a high-signal review with no speculative noise.
