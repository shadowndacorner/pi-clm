import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseProposal, systemPrompt, userMessage } from "../icl/proposer.ts";

const response = `
<<<ANALYSIS>>>
The winning loop: keep the found answer, drop search scaffolding (E2 step 3). Failure
mode: losing runs re-read sources every turn (E1 step 7, E1 step 12).
<<<END>>>

<<<SKILL name=Keep Findings>>>>>>
---
name: keep-findings
description: Keeps verified findings; drop scaffolding. Evidence E2 step 3, E1 step 12.
---
## Protocol
1. Record any verified finding in the notes block immediately.
2. After each search round, delete tool scaffolding you no longer need (cite E1 step 7).
<<<END>>>

<<<SKILL name=Broken>>>>>>
---
name: broken
description: No evidence citation here.
---
## Nothing
<<<END>>>

䷗ SKILL name=NotABlock
junk that must not parse
 <<<END>>> junk
`;

test("parseProposal: analysis + valid skill parsed, invalid dropped", () => {
	const p = parseProposal(response, 4);
	assert.ok(p.analysis.length > 0);
	assert.match(p.analysis, /winning loop/);
	assert.equal(p.skills.length, 1);
	assert.equal(p.skills[0]![0], "keep-findings");
	assert.match(p.skills[0]![1], /^---\nname: keep-findings/);
	assert.ok(p.rejected.some((r) => /skill broken/i.test(r) && r.includes("cites no episode or step")));
});

test("parseProposal: over-limit skills are truncated and reported", () => {
	const two = `${response}\n<<<SKILL name=extra>>>>>>\n---\nname: extra\ndescription: cites E1 step 4.\n---\nbody\n<<<END>>>\n`;
	const p = parseProposal(two, 1);
	assert.equal(p.skills.length, 1);
	assert.ok(p.rejected.some((r) => r.includes("over the 1-candidate limit")));
});


test("parseProposal: no blocks at all is reported", () => {
	const p = parseProposal("no structured content at all", 4);
	assert.ok(p.rejected.some((r) => r.includes("no parseable <<<SKILL")));
	assert.equal(p.skills.length, 0);
});

test("systemPrompt substitutes {N}", () => {
	assert.match(systemPrompt(7, "emit {N} candidates"), /emit 7 candidates/);
});

test("userMessage section order", () => {
	const msg = userMessage("skill text", "note text", "task desc");
	const order = ["## TASKS", "## CURRENT SKILL", "## NOTE ON", "## YOUR TASK"].map((h) => msg.indexOf(h));
	assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]! && order[2]! < order[3]!);
	assert.match(msg, /skill text/);
});

