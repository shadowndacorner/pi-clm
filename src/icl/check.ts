// pi-native piece of the facebookresearch/context-language-models port (fork of @lolipopshock/pi-clm).
// See docs/icl.md for the task contract and provenance.
import type { Episode } from "./episode.ts";
import { isValidEpisode } from "./episode.ts";
import { type Score, diffSe, gate, score } from "./gate.ts";

/**
 * Stop-on-regression check: does a candidate skill regress against a baseline
 * on a shared task set? Task-level rule (the contract): for every task where
 * the baseline was graded, the candidate must not score strictly lower.
 * Overall accuracy/cost comparison via the standard gate is reported too.
 *
 * An ungraded candidate episode where the baseline was graded makes the whole
 * check unverifiable (fail closed, exit 2): it is not a pass.
 */

export interface TaskPair {
	taskId: string;
	baselineMean: number | null;
	candidateMean: number | null;
	regression: boolean;
	blocked: boolean;
}

export interface CheckReport {
	candidate: string;
	baseline: string;
	tasks: TaskPair[];
	regressions: string[];
	blockedTasks: string[];
	/** true = no regression and nothing blocked. */
	passed: boolean;
	/** Overall gate (paired SE, accuracy/cost) for context — informational. */
	overall: { passed: boolean; reason: string };
}

function taskMeans(episodes: Episode[]): Map<string, number | null> {
	const perTask = new Map<string, number[]>();
	for (const e of episodes) {
		if (!isValidEpisode(e)) continue;
		if (!perTask.has(e.taskId)) perTask.set(e.taskId, []);
		perTask.get(e.taskId)!.push(e.reward!);
	}
	const out = new Map<string, number | null>();
	for (const [t, list] of perTask) {
		out.set(t, list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
	}
	return out;
}

const eps = 1e-9;

export function checkRegression(
	baselineId: string,
	baselineEpisodes: Episode[],
	candidateId: string,
	candidateEpisodes: Episode[],
): CheckReport {
	const base = taskMeans(baselineEpisodes);
	const cand = taskMeans(candidateEpisodes);
	const tasks: TaskPair[] = [];
	const regressions: string[] = [];
	const blockedTasks: string[] = [];
	const taskIds = [...new Set([...base.keys(), ...cand.keys()])].sort();
	for (const taskId of taskIds) {
		const b = base.get(taskId) ?? null;
		const c = cand.get(taskId) ?? null;
		// blocked: baseline graded but candidate produced no grade
		const blocked = b !== null && c === null;
		const regression = b !== null && c !== null && c < b - eps;
		tasks.push({ taskId, baselineMean: b, candidateMean: c, regression, blocked });
		if (blocked) blockedTasks.push(taskId);
		if (regression) regressions.push(`${taskId}: ${c} < baseline ${b}`);
	}
	const bScore: Score = score(baselineEpisodes);
	const cScore: Score = score(candidateEpisodes);
	const [ok, reason] = gate(cScore, bScore);
	const passed = regressions.length === 0 && blockedTasks.length === 0;
	void bScore;
	void cScore;
	void diffSe;
	return {
		candidate: candidateId,
		baseline: baselineId,
		tasks,
		regressions,
		blockedTasks,
		passed,
		overall: { passed: ok, reason },
	};
}
