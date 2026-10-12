import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { parseSession, stepDigest } from "../icl/session.ts";
import { type Episode, episode } from "../icl/episode.ts";
import { buildNote } from "../icl/note.ts";

const entry = (obj: unknown): string => JSON.stringify(obj);

test("parseSession maps per-request composition: delta vs prior + tool-result share", async () => {
	const session = [
		entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "task prompt" }] } }),
		entry({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(600) }] } }),
		entry({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "note" }],
				usage: { input: 800, output: 10, totalTokens: 810, cost: { total: 0.001 } },
			},
		}),
		entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "go on" }] } }),
		entry({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(1200) }] } }),
		entry({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "more" }],
				usage: { input: 1200, output: 12, totalTokens: 1212, cost: { total: 0.001 } },
			},
		}),
	].join("\n") + "\n";
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "clm-comp-"));
	const path = join(dir, "session.jsonl");
	await writeFile(path, session, "utf8");
	const facts = await parseSession(path);
	await rm(dir, { recursive: true, force: true });

	assert.equal(facts.composition.length, 2);
	const [first, second] = facts.composition;
	assert.equal(first!.inputTokens, 800);
	assert.equal(first!.deltaTokens, null);
	// 600 tool bytes / 600+10 total bytes → 98% (rounded down-ish)
	assert.ok(first!.toolResultSharePct! > 90, `first share ${first!.toolResultSharePct}`);
	assert.equal(second!.inputTokens, 1200);
	assert.equal(second!.deltaTokens, 400);
	// second request: only new bytes were the "go on" user text (5 ch) + 1200 tool
	assert.ok(second!.toolResultSharePct! > 90, `second share ${second!.toolResultSharePct}`);

	// Step lines carry the composition for the proposer to cite.
	const digest = stepDigest(facts.steps);
	assert.match(digest, /ctx ~800 tok \(first request; tool-result \d+% of new bytes\)/);
	assert.match(digest, /ctx ~1200 tok \(Δ\+400 vs prior; tool-result \d+% of new bytes\)/);
});

test("recorded fixture: the composition lands in a real note built from a real session", async () => {
	const path = new URL("./fixtures/icl-session-episode.jsonl", import.meta.url).pathname;
	const facts = await parseSession(path);
	assert.ok(facts.composition.length >= 1);
	const e: Episode = episode({
		taskId: "fruits",
		rep: 0,
		reward: 1,
		cost: 0.005,
		costMetric: "usd",
		extra: { turns: facts.turns, contextEdits: facts.contextEdits, digest: stepDigest(facts.steps) },
	});
	const note = buildNote([e], (it) => (it.extra?.["digest"] as string) ?? "", { k: 3 });
	assert.match(note, /ctx ~\d+ tok /);
	assert.match(note, /tool-result \d+% of new bytes/);
});
