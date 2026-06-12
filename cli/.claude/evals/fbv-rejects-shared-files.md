---
id: fbv-rejects-shared-files
kind: capability
grader: code
k: 1
target: "pass@1>=0.90"
human_gate: false
baseline: 78ba1029f27b
refs: ["docs/ORCHESTRATION-REALIGN-DESIGN.md#O3", "docs/ORCHESTRATION-REALIGN-DESIGN.md#O5", "skills/orchestrate-delivery/SKILL.md"]
---

## Behavior
`workflows/foundation-build-verify.js` enforces one-writer-per-file structurally: the
exported file-disjointness check throws BEFORE any agent is spawned when two build units
declare intersecting `files`. The check is a pure, named export so it is testable without
a Workflow runtime.

## Success criteria
- [ ] importing the script exposes a named pure function (`assertDisjointFiles`) — the
      disjointness check, callable with no Workflow runtime
- [ ] calling it with two units that share a file THROWS (and the message names the
      offending shared file)
- [ ] calling it with two units that own disjoint files does NOT throw (the boundary:
      legitimate parallelism is allowed)
- [ ] a `files: null` unit is allowed (forced-sequential sentinel, never a shared-file
      collision)

## Grader
<code> cd <forge-root> &&
node --input-type=module -e '
import { assertDisjointFiles } from "./workflows/foundation-build-verify.js";
const fails=[];
if(typeof assertDisjointFiles!=="function")fails.push("assertDisjointFiles is not an exported function");
// shared file => throws, message names the file
let threw=false,msg="";
try{ assertDisjointFiles([{label:"a",files:["src/x.ts"]},{label:"b",files:["src/x.ts","src/y.ts"]}]); }
catch(e){ threw=true; msg=String(e&&e.message||e); }
if(!threw)fails.push("shared file did NOT throw");
else if(!/x\.ts/.test(msg))fails.push("throw message did not name the shared file: "+msg);
// disjoint => no throw
try{ assertDisjointFiles([{label:"a",files:["src/x.ts"]},{label:"b",files:["src/y.ts"]}]); }
catch(e){ fails.push("disjoint files threw: "+String(e&&e.message||e)); }
// files:null sentinel => allowed
try{ assertDisjointFiles([{label:"a",files:null},{label:"b",files:["src/x.ts"]}]); }
catch(e){ fails.push("files:null sentinel threw: "+String(e&&e.message||e)); }
if(fails.length){console.error("FAIL:\n - "+fails.join("\n - "));process.exit(1);}
console.log("PASS");
' ;
PASS = exit 0 AND prints "PASS"
