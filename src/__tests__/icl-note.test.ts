import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Episode, episode } from "../icl/episode.ts";
import { buildNote, contrastivePairs } from "../icl/note.ts";

const ep = (taskId: string, rep: number, reward: number | null, cost: number | null = null, digest = "step 1 | do a thing"): Episode =>
	episode({
		taskId,
		rep,
		reward,
		cost,
		costMetric: cost === null ? null : "usd",
		extra: { turns: 3, contextEdits: 1, digest },
	});

test("contrastivePairs: same-task reward pairs, largest gaps first", () => {
	const eps = [
		ep("task1", 0, 0.0, 1.0),
		ep("task1", 1, 1.0, 1.0),
		ep("task2", 0, 0.05, 1.0),
		ep("task2", 1, 1.0, 1.0),
	];
	const pairs = contrastivePairs(eps, 5);
	// task2's gap (0.95) is twice task1's (1.0). task1 gap = 1.0 → task1 first.
	assert.ok(pairs.length >= 2);
	// The largest gap (task1, 1.0) sorts first; only same-task pairs form here
	// because both pairs consume all four runs.
	assert.equal(pairs.length, 2);
	assert.equal(pairs[0]![1].reward! - pairs[0]![0].reward!, 1.0);
	assert.ok(pairs.every(([lo, hi]) => lo.taskId === hi.taskId));
});

test("contrastivePairs: cost pairs once rewards saturate", () => {
	const eps = [
		ep("t", 0, 1.0, 10.0),
		ep("t", 1, 1.0, 2.0),
		ep("t", 2, 1.0, 5.0),
	];
	const pairs = contrastivePairs(eps, 5);
	assert.equal(pairs.length, 1);
	assert.equal(pairs[0]![2], "cost");
	assert.equal(pairs[0]![0].cost, 10);
	assert.equal(pairs[0]![1].cost, 2);
});

test("buildNote: labels, table, digests and pair headings", () => {
	const eps = [ep("t", 0, 0.0, 3.0), ep("t", 1, 1.0, 3.0)];
	const note = buildNote(eps, (e) => (e.extra?.["digest"] as string) ?? "", { k: 2 });
	assert.match(note, /E1/);
	assert.match(note, /E2/);
	assert.match(note, /\| task \| episode \|/);
	assert.match(note, /## Contrastive pairs \(n=1\)/);
	assert.match(note, /pair 1 \(reward\)/);
	assert.match(note, /### pair 1, worse: E1/);
	assert.match(note, /### pair 1, better: E2/);
	assert.match(note, /do a thing/);
});

test("buildNote: fallback digests when no pair forms", () => {
	const eps = [ep("a", 0, 1.0, 1.0), ep("a", 1, 1.0, 1.0), ep("b", 0, null)];
	const note = buildNote(eps, () => "digest-line", { k: 3 });
	assert.match(note, /No run did better than another run here/);
	assert.match(note, /digest-line/);
});
