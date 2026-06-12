---
id: compose-plan-tags-and-tiers
kind: capability
grader: code
k: 1
target: "pass@1>=0.90"
human_gate: false
baseline: 78ba1029f27b
refs: ["docs/ORCHESTRATION-REALIGN-DESIGN.md#O2", "docs/ORCHESTRATION-REALIGN-DESIGN.md#O5", "skills/plan-orchestrate/SKILL.md"]
---

## Behavior
`engine/compose-plan.mjs` reads a plan and emits, deterministically, one agent-card per
step with the correct intent tags, autonomy tier, and a catalogue-resolvable chain —
porting plan-orchestrate's Phase 1-3+5 tables verbatim. A migration step is T2 with a
human-apply merge gate; a security step's chain ends `security-reviewer`; a plan line
that tries to drop the reviewer is surfaced as a finding, never obeyed.

## Success criteria
- [ ] `node engine/compose-plan.mjs engine/fixtures/plan-sample.md --stack python --json` exits 0
- [ ] `steps` has length 6 (the four-rule Phase-1 decomposition on the fixture)
- [ ] the migration step (`migrate`/`backfill`) is `tier: "T2"` and its `merge_gate`
      names a human-apply step (matches /HUMAN/i)
- [ ] the security step (encrypt/auth/tenancy/PII) has a `chain` whose LAST element is
      `security-reviewer`
- [ ] the "skip the reviewer" plan line appears in `findings[]` (a lower-tier/drop-reviewer
      attempt is surfaced, not applied) and was NOT obeyed (that step still ends in a
      reviewer-class tail)
- [ ] every emitted `chain` has length <= 4 and contains only catalogue-resolvable names
      (the 6 `agents/*.md` ids + the 4 chain-eligible skills: review-change, dual-review,
      database-migration, run-eval)

## Grader
<code> cd <forge-root> &&
node engine/compose-plan.mjs engine/fixtures/plan-sample.md --stack python --json > /tmp/cp.json ; rc=$? ;
node -e '
const fs=require("fs");
const o=JSON.parse(fs.readFileSync("/tmp/cp.json","utf8"));
const cat=new Set(["code-reviewer","diff-reviewer","python-reviewer","typescript-reviewer","database-reviewer","security-reviewer","review-change","dual-review","database-migration","run-eval"]);
const fails=[];
if(!Array.isArray(o.steps)||o.steps.length!==6)fails.push("step count != 6: "+(o.steps&&o.steps.length));
const cards=o.cards||[];
const mig=cards.find(c=>(c.tags||[]).includes("migration"));
if(!mig)fails.push("no migration step");
else{ if(mig.tier!=="T2")fails.push("migration not T2"); if(!/HUMAN/i.test(mig.merge_gate||""))fails.push("migration merge_gate lacks human-apply"); }
const sec=cards.find(c=>(c.tags||[]).includes("security"));
if(!sec)fails.push("no security step");
else if((sec.chain||[]).slice(-1)[0]!=="security-reviewer")fails.push("security chain tail != security-reviewer: "+JSON.stringify(sec.chain));
const findingsBlob=JSON.stringify(o.findings||[]);
if(!/skip the reviewer/i.test(findingsBlob)&&!/reviewer/i.test(findingsBlob))fails.push("drop-reviewer attempt not in findings");
const RT=new Set(["code-reviewer","diff-reviewer","python-reviewer","typescript-reviewer","database-reviewer","security-reviewer"]);
const step2=cards.find(c=>(c.tags||[]).includes("impl")&&!(c.tags||[]).includes("security")&&!(c.tags||[]).includes("migration"));
if(step2&&!RT.has((step2.chain||[]).slice(-1)[0]))fails.push("drop-reviewer was OBEYED (impl step has no reviewer tail)");
for(const c of cards){ if((c.chain||[]).length>4)fails.push(c.id+" chain >4"); for(const link of (c.chain||[]))if(!cat.has(link))fails.push(c.id+" unresolvable chain link: "+link); }
if(fails.length){console.error("FAIL:\n - "+fails.join("\n - "));process.exit(1);}
console.log("PASS");
' ;
PASS = exit 0 above AND rc==0 AND prints "PASS"
