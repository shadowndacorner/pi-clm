import type { Episode } from "./episode.ts";
import { isValidEpisode } from "./episode.ts";

/**
 * Scores and the selection gate. Direct port of clm_icl.evolve.py:
 *
 * - d is mean reward of the candidate minus the incumbent's, with tasks as the
 *   unit (reward averaged over repeats of a task);
 * - SE is paired (standard error of the per-task differences) when both skills
 *   were graded on the same tasks, else sqrt(se_a^2 + se_b^2);
 * - pass when d > SE (more accurate), or when |d| <= SE and mean cost is lower
 *   in the same metric; every dev episode must be graded;
 * - among passing candidates, those within one SE of the most accurate count as
 *   tied and the cheapest of them wins.
 */

export interface Score {
	n: number;
	nValid: number;
	acc: number | null;
	cost: number | null;
	costMetric: string | null;
	/** Mean graded reward per task; the unit for standard errors. */
	taskRewards: Record<string, number>;
}

export function complete(s: Score): boolean {
	return s.n > 0 && s.nValid === s.n;
}

export function score(episodes: Episode[]): Score {
	/** Mean reward over graded episodes; mean cost only if every graded episode has a
	 * cost in one metric (otherwise null — not comparable). */
	const valid = episodes.filter(isValidEpisode);
	const acc = valid.length ? valid.reduce((a, e) => a + e.reward!, 0) / valid.length : null;
	const metrics = new Set(valid.map((e) => e.costMetric).filter(Boolean));
	let cost: number | null = null;
	let metric: string | null = null;
	if (valid.length && metrics.size === 1 && valid.every((e) => e.cost !== null)) {
		cost = valid.reduce((a, e) => a + e.cost!, 0) / valid.length;
		metric = [...metrics][0]!;
	}
	const perTask = new Map<string, number[]>();
	for (const e of valid) {
		if (!perTask.has(e.taskId)) perTask.set(e.taskId, []);
		perTask.get(e.taskId)!.push(e.reward!);
	}
	const taskRewards: Record<string, number> = {};
	for (const [t, list] of perTask) taskRewards[t] = list.reduce((a, b) => a + b, 0) / list.length;
	return { n: episodes.length, nValid: valid.length, acc, cost, costMetric: metric, taskRewards };
}

const eps = 1e-9;

function sem(xs: number[]): number {
	/** Standard error of the mean (sample standard deviation); 0 for fewer than 2. */
	if (xs.length < 2) return 0.0;
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}

export function diffSe(a: Score, b: Score): [number, "paired" | "unpaired"] {
	/** SE of acc(a) - acc(b), tasks as the unit. Paired when both skills were graded
	 * on the same task set; else unpaired combined SEMs. */
	const ta = a.taskRewards ?? {};
	const tb = b.taskRewards ?? {};
	if (Object.keys(ta).length && new Set(Object.keys(ta)).size === Object.keys(tb).length && Object.keys(ta).every((t) => t in tb)) {
		return [sem(Object.keys(ta).map((t) => ta[t] - tb[t])), "paired"];
	}
	return [Math.hypot(sem(Object.values(ta)), sem(Object.values(tb))), "unpaired"];
}

export function gate(cand: Score, inc: Score): [boolean, string] {
	/** Gate on the development tasks: d > SE pass (higher accuracy); d < -SE fail
	 * (lower); otherwise a tie — pass only if mean cost is lower, same metric.
	 * The candidate must be graded on every development episode. */
	if (!complete(cand)) return [false, `only ${cand.nValid}/${cand.n} episodes graded`];
	if (inc.acc === null) return [true, "incumbent has no accuracy"];
	if (cand.acc === null) return [false, "candidate has no accuracy"];
	const d = cand.acc - inc.acc;
	const [se, kind] = diffSe(cand, inc);
	const accTxt = `acc ${cand.acc!.toFixed(4)} vs ${inc.acc!.toFixed(4)}, diff ${d >= 0 ? "+" : ""}${d.toFixed(4)}, SE ${se.toFixed(4)} (${kind})`;
	if (d > se + eps) return [true, `higher accuracy: ${accTxt}`];
	if (d < -se - eps) return [false, `lower accuracy: ${accTxt}`];
	if (cand.cost === null || inc.cost === null || cand.costMetric !== inc.costMetric) {
		return [false, `tie within 1 SE, cost not comparable: ${accTxt}`];
	}
	const costTxt = `cost ${cand.cost.toPrecision(4)} vs ${inc.cost.toPrecision(4)} ${cand.costMetric}`;
	if (cand.cost < inc.cost) return [true, `tie within 1 SE, lower cost: ${accTxt}; ${costTxt}`];
	return [false, `tie within 1 SE, not cheaper: ${accTxt}; ${costTxt}`];
}

export function pick(passing: [string, Score][]): string {
	/** Most accurate passing candidate; candidates within one SE of it count as
	 * tied, and the cheapest of those wins. */
	const bestAcc = Math.max(...passing.map(([, s]) => s.acc!));
	const best = passing.find(([, s]) => s.acc === bestAcc)![1];
	const tied = passing.filter(([, s]) => bestAcc - s.acc! <= diffSe(best, s)[0] + eps);
	const inf = Number.POSITIVE_INFINITY;
	const tupleCompare = (a: Score, b: Score): number => {
		const ac = a.cost ?? inf;
		const bc = b.cost ?? inf;
		if (ac !== bc) return ac - bc;
		return -(a.acc ?? 0) + (b.acc ?? 0);
	};
	let winner = tied[0]!;
	for (const entry of tied.slice(1)) {
		if (tupleCompare(entry[1], winner[1]) < 0) winner = entry;
	}
	return winner[0];
}

export function pareto(scores: Record<string, Score>): string[] {
	/** Skills no other skill matches or beats on both accuracy and cost. */
	const pts = Object.fromEntries(
		Object.entries(scores).filter(([, s]) => s.acc !== null && s.cost !== null),
	);
	const out: string[] = [];
	for (const [k, s] of Object.entries(pts)) {
		const dominated = Object.entries(pts).some(([j, o]) => {
			if (j === k || o.costMetric !== s.costMetric) return false;
			return o.acc! >= s.acc! && o.cost! <= s.cost! && (o.acc! > s.acc! || o.cost! < s.cost!);
		});
		if (!dominated) out.push(k);
	}
	return out.sort((a, b) => pts[a]!.cost! - pts[b]!.cost!);
}
