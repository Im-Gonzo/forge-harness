---
name: broken-frontmatter
description: "MALFORMED artifact — the frontmatter block is never closed (no terminating --- line), so a tolerant parser cannot extract a complete contract.
tools: [Read, Grep
model sonnet
owner: forge
tags: [review

# broken-frontmatter (one-bad fixture, MALFORMED)

This file deliberately has an UNCLOSED frontmatter fence: the opening `---` has
no matching closing `---`, the description string quote is never closed, the
`tools` list bracket is never closed, and `model sonnet` is missing its colon.
A fail-open registry build (BR-REG-010) must skip this file, emit exactly one
finding in the {level,path,line,message,source:"validate-registry"} shape, and
NOT abort — the two valid agents are still recorded.
