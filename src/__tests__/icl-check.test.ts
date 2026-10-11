import { strict as assert } from "node:assert";
import { test } from "node:test";
import { episode } from "../icl/episode.ts";
import { checkRegression } from "../icl/check.ts";

const ep = (taskId: string, rep: number, reward: number | null) =>
	episode({ taskId, rep, reward, cost: reward === null ? null : 0.001, costMetric: reward === null ? null : "usd" });

test("checkRegression: passes when candidate matches baseline", () => {
	const base = [ep("a", 0, 1), ep("b", 0, 1)];
	const cand = [ep("a", 0, 1), ep("b", 0, 1)];
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(r.passed);
	assert.equal(r.regressions.length, 0);
	assert.equal(r.blockedTasks.length, 0);
	assert.equal(r.tasks.length, 2);
});

test("checkRegression: strict per-task drop fails", () => {
	const base = [ep("a", 0, 1), ep("b", 0, 1), ep("c", 0, 1)];
	const cand = [ep("a", 0, 1), ep("b", 0, 1), ep("c", 0, 0)]; // drop on c only
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(!r.passed);
	assert.equal(r.regressions.length, 1);
	assert.match(r.regressions[0]!, /^c:/);
});

test("checkRegression: improvement on one task, no drop elsewhere → pass", () => {
	const base = [ep("a", 0, 0.5), ep("b", 0, 1)];
	const cand = [ep("a", 0, 1), ep("b", 0, 1)];
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(r.passed);
});

test("checkRegression: ungraded candidate where baseline graded → blocked, not pass", () => {
	const base = [ep("a", 0, 1), ep("b", 0, 1)];
	const cand = [ep("a", 0, 1), ep("b", 0, null)];
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(!r.passed);
	assert.deepEqual(r.blockedTasks, ["b"]);
});

test("checkRegression: ungraded BASELINE episode does not block", () => {
	const base = [ep("a", 0, 1), ep("b", 0, null)];
	const cand = [ep("a", 0, 1), ep("b", 0, 1)];
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(r.passed); // only candidate-side gaps block
	assert.equal(r.tasks[1]!.candidateMean, 1);
});

test("checkRegression: per-rep means on the shared task set", () => {
	const base = [ep("a", 0, 0), ep("a", 1, 1)]; // mean 0.5
	const cand = [ep("a", 0, 0.5), ep("a", 1, 0.5)]; // mean 0.5 → no regression
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(r.passed);
	assert.equal(r.tasks[0]!.candidateMean, 0.5);
});

test("checkRegression: optional-task knowledge added by candidate is fine", () => {
	// candidate graded on a task the baseline was not graded on: no regression possible
	const base = [ep("a", 0, 1)];
	const cand = [ep("a", 0, 1), ep("new", 0, 1)];
	const r = checkRegression("baseline", base, "cand", cand);
	assert.ok(r.passed);
});
