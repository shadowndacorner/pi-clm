import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Episode, episode } from "../icl/episode.ts";
import { type Score, complete, diffSe, gate, pareto, pick, score } from "../icl/gate.ts";

const ep = (taskId: string, rep: number, reward: number | null, cost: number | null = null): Episode =>
	episode({ taskId, rep, reward, cost, costMetric: reward === null ? null : "usd" });

test("score: mean reward, per-task means, completeness", () => {
	const s = score([ep("a", 0, 1, 0.01), ep("a", 1, 0, 0.02), ep("b", 0, 1, 0.02), ep("c", 0, null)]);
	assert.equal(s.n, 4);
	assert.equal(s.nValid, 3);
	assert.ok(Math.abs(s.acc! - 2 / 3) < 1e-9);
	assert.equal(s.taskRewards["a"], 0.5);
	assert.equal(s.taskRewards["b"], 1);
	assert.ok(!complete(s)); // one ungraded episode → incomplete
	assert.ok(complete(score([ep("a", 0, 1), ep("a", 1, 0)])));
});

test("score: mixed cost metrics are not comparable", () => {
	const e1 = episode({ taskId: "a", rep: 0, reward: 1, cost: 0.01, costMetric: "usd" });
	const e2 = episode({ taskId: "a", rep: 1, reward: 1, cost: 100, costMetric: "tokens" });
	assert.equal(score([e1, e2]).cost, null);
});

test("diffSe: paired when same task set", () => {
	const a = score([ep("a", 0, 1), ep("b", 0, 0)]);
	const b = score([ep("a", 0, 0), ep("b", 0, 0)]);
	const [se, kind] = diffSe(a, b);
	assert.equal(kind, "paired");
	// per-task diffs: a 1, b 0 → mean 0.5, se = 0.5/sqrt(2)
	// per-task diffs: a 1, b 0 → two diffs (1, 0) → se = 0.5
	assert.ok(Math.abs(se - 0.5) < 1e-9);
});

test("diffSe: unpaired when task sets differ", () => {
	const a = score([ep("a", 0, 1), ep("a", 1, 0)]);
	const b = score([ep("b", 0, 1), ep("b", 1, 0)]);
	const [se, kind] = diffSe(a, b);
	assert.equal(kind, "unpaired");
	assert.equal(se, 0); // 1 episode per task, each task one repeat → per-task SEM 0
});

test("gate: higher accuracy passes, lower fails, tie needs lower cost", () => {
	const inc = score([ep("a", 0, 0.5), ep("b", 0, 0.5)]);
	const better = score([ep("a", 0, 1), ep("b", 0, 1)]);
	const [ok, why] = gate(better, inc);
	assert.ok(ok);
	assert.match(why, /higher accuracy/);
	const worse = score([ep("a", 0, 0), ep("b", 0, 0)]);
	assert.ok(!gate(worse, inc)[0]);
	const tie = score([ep("a", 0, 0.5, 0.001), ep("b", 0, 0.5, 0.001)]);
	const incCost = score([ep("a", 0, 0.5, 0.01), ep("b", 0, 0.5, 0.01)]);
	const [tieOk, tieWhy] = gate(tie, incCost);
	assert.ok(tieOk);
	assert.match(tieWhy, /lower cost/);
	assert.ok(!gate(tie, tie)[0]); // same cost
});

test("gate: incomplete candidate fails", () => {
	const inc = score([ep("a", 0, 0.5)]);
	const cand = score([ep("a", 0, 1), ep("b", 0, null)]);
	const [ok, why] = gate(cand, inc);
	assert.ok(!ok);
	assert.match(why, /episodes graded/);
});

test("pick: cheapest within 1 SE of the best wins", () => {
	const strong: [string, Score] = ["strong", score([ep("a", 0, 1.0, 0.10), ep("b", 0, 1.0, 0.10)])];
	const tied: [string, Score] = ["tied", score([ep("a", 0, 1.0, 0.01), ep("b", 0, 1.0, 0.01)])];
	const weak: [string, Score] = ["weak", score([ep("a", 0, 0.5, 0.01), ep("b", 0, 0.5, 0.01)])];
	assert.equal(pick([strong, tied, weak]), "tied");
});

test("pareto: keeps non-dominated skills only", () => {
		const scores: Record<string, Score> = {
		hi_acc_hi_cost: { n: 2, nValid: 2, acc: 1, cost: 2, costMetric: "usd", taskRewards: {} },
		lo_acc_lo_cost: { n: 2, nValid: 2, acc: 0.5, cost: 1, costMetric: "usd", taskRewards: {} },
		hi_acc_lo_cost: { n: 2, nValid: 2, acc: 1, cost: 1, costMetric: "usd", taskRewards: {} },
		dominated: { n: 2, nValid: 2, acc: 0.9, cost: 1.5, costMetric: "usd", taskRewards: {} },
	};
		const frontier = pareto(scores);
	assert.ok(!frontier.includes("hi_acc_hi_cost")); // dominated by hi_acc_lo_cost
	assert.ok(!frontier.includes("lo_acc_lo_cost")); // also dominated by hi_acc_lo_cost
	assert.ok(frontier.includes("hi_acc_lo_cost"));
	assert.ok(!frontier.includes("dominated"));
});
