// Ported from facebookresearch/context-language-models — clm/clm_icl/note.py.
// Fork of @lolipopshock/pi-clm; see docs/icl.md for provenance and task contract.
import type { Episode } from "./episode.ts";
import { isValidEpisode } from "./episode.ts";

/**
 * The contrastive note: evidence the proposer reads before writing candidate
 * skills. Port of clm_icl.note.py.
 *
 * From the current skill's episodes on the training tasks, pick pairs of runs
 * of the same task where one did better than the other (higher reward, or the
 * same reward at lower cost), and write a summary table plus a step-indexed
 * digest of each run in a pair. Episodes are labelled E1, E2, ... so the
 * proposer can cite them.
 */

function mean(xs: number[]): number | null {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function fmt(x: number | null, nd = 3): string {
	if (x === null) return "-";
	if (Math.abs(x) >= 1e4 || (Math.abs(x) > 0 && Math.abs(x) < 1e-3)) return x.toExponential(nd - 1);
	return x.toFixed(nd);
}

const costOf = (e: Episode): number => e.cost ?? 0.0;

type Pair = [Episode, Episode, string];

function roundRobin(queues: [number, Episode, Episode][][], pairs: Pair[], used: Set<Episode>, k: number, kind: string): void {
	for (const q of queues) q.sort((a, b) => b[0] - a[0]);
	// Sort queues by their best slot's gap descending, so the largest gaps fill
	// the limited pair budget first.
	queues.sort((a, b) => (b[0]?.[0] ?? -Infinity) - (a[0]?.[0] ?? -Infinity));
	while (pairs.length < k && queues.some((q) => q.length > 0)) {
		for (const q of queues) {
			while (q.length > 0 && pairs.length < k) {
				const [, lo, hi] = q.shift()!;
				if (used.has(lo) || used.has(hi)) continue;
				pairs.push([lo, hi, kind]);
				used.add(lo);
				used.add(hi);
				break;
			}
		}
	}
}

export function contrastivePairs(episodesIn: Episode[], k = 5): Pair[] {
	/** Up to k (worse, better, kind) pairs, in this order of preference:
	 *  1. reward: two runs of the same task with different rewards;
	 *  2. reward, across tasks: the worst and best remaining runs of different tasks;
	 *  3. cost: two successful runs of the same task with the same reward, the better one cheaper.
	 *  Within 1 and 3, tasks with the largest gap come first and slots go round robin
	 *  over tasks, so a few tasks cannot fill every slot. */
	const pairs: Pair[] = [];
	const used = new Set<Episode>();
	const valid = episodesIn.filter(isValidEpisode);
	const byTask = new Map<string, Episode[]>();
	for (const e of valid) {
		if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
		byTask.get(e.taskId)!.push(e);
	}
	// 1. same task, different reward: worst runs against best runs
	const rewardQueues: [number, Episode, Episode][][] = [];
	for (const eps of byTask.values()) {
		const sorted = [...eps].sort((a, b) => a.reward! - b.reward! || costOf(b) - costOf(a));
		const h = Math.floor(sorted.length / 2);
		const low = sorted.slice(0, h);
		const high = sorted.slice(-h).reverse();
		const q: [number, Episode, Episode][] = [];
		for (let i = 0; i < h; i++) {
			const [lo, hi] = [low[i], high[i]];
			if (hi!.reward! > lo!.reward!) q.push([hi!.reward! - lo!.reward!, lo!, hi!]);
		}
		rewardQueues.push(q);
	}
	roundRobin(rewardQueues, pairs, used, k, "reward");

	// 2. across tasks: worst remaining against best remaining
	const rest = valid.filter((e) => !used.has(e)).sort((a, b) => a.reward! - b.reward! || costOf(b) - costOf(a));
	while (pairs.length < k && rest.length >= 2 && rest[rest.length - 1].reward! > rest[0].reward!) {
		const lo = rest.shift()!;
		const hi = rest.pop()!;
		if (lo.taskId === hi.taskId) continue;
		pairs.push([lo, hi, "reward, across tasks"]);
		used.add(lo);
		used.add(hi);
	}

	// 3. same task and reward, successful runs: expensive against cheap
	const costQueues: [number, Episode, Episode][][] = [];
	for (const eps of byTask.values()) {
		const groups = new Map<number, Episode[]>();
		for (const e of eps) {
			if ((e.reward ?? 0) > 0 && e.cost !== null && !used.has(e)) {
				if (!groups.has(e.reward!)) groups.set(e.reward!, []);
				groups.get(e.reward!)!.push(e);
			}
		}
		const q: [number, Episode, Episode][] = [];
		for (const g of groups.values()) {
			const sorted = [...g].sort((a, b) => costOf(b) - costOf(a));
			const h = Math.floor(sorted.length / 2);
			const expensive = sorted.slice(0, h);
			const cheap = sorted.slice(-h).reverse();
			for (let i = 0; i < h; i++) {
				const [lo, hi] = [expensive[i], cheap[i]];
				if (costOf(lo!) > costOf(hi!)) q.push([costOf(lo!) - costOf(hi!), lo!, hi!]);
			}
		}
		if (q.length > 0) costQueues.push(q);
	}
	roundRobin(costQueues, pairs, used, k, "cost");
	return pairs;
}

export function buildNote(
	episodes: Episode[],
	digest: (e: Episode) => string,
	options: { k?: number; labels?: Map<Episode, string> } = {},
): string {
	/** Markdown note for the proposer: per-task table, pairs, and digests. */
	const k = options.k ?? 5;
	const labels = options.labels ?? new Map(episodes.map((e, i) => [e, `E${i + 1}`]));
	const label = (e: Episode): string => labels.get(e) ?? "?";
	const valid = episodes.filter(isValidEpisode);
	const metrics = [...new Set(valid.filter((e) => e.costMetric).map((e) => e.costMetric!))].sort();
	const lines: string[] = ["# Rollouts of the current skill on the training tasks", ""];
	const acc = mean(valid.map((e) => e.reward!));
	const costs = valid.filter((e) => e.cost !== null).map((e) => e.cost!);
	lines.push(
		`episodes: ${episodes.length} (${episodes.length - valid.length} without a grade); ` +
			`mean reward ${fmt(acc)}; mean cost ${fmt(mean(costs))} ` +
			`(${metrics.join(", ") || "not measured"})`,
	);
	lines.push("", "| task | episode | reward | cost | turns | context edits |", "|---|---|---|---|---|---|");
	for (const e of episodes) {
		const x = e.extra ?? {};
		lines.push(
			`| ${e.taskId} | ${label(e)} | ${fmt(e.reward, 2)} | ${fmt(e.cost)} ` +
				`| ${x["turns"] ?? "-"} | ${x["contextEdits"] ?? "-"} |`,
		);
	}
	const pairs = contrastivePairs(episodes, k);
	lines.push("", `## Contrastive pairs (n=${pairs.length})`, "", "Each pair is a worse run and a better run, of the same task unless noted.", "");
	pairs.forEach(([lo, hi, kind], i) => {
		lines.push(
			`- pair ${i + 1} (${kind}): worse ${label(lo)} (task ${lo.taskId}, reward ${fmt(lo.reward, 2)}, ` +
				`cost ${fmt(lo.cost)}) vs better ${label(hi)} (task ${hi.taskId}, reward ${fmt(hi.reward, 2)}, ` +
				`cost ${fmt(hi.cost)})`,
		);
	});
	pairs.forEach(([lo, hi, _kind], i) => {
		for (const [tag, e] of [["worse", lo], ["better", hi]] as const) {
			lines.push("", `### pair ${i + 1}, ${tag}: ${label(e)} (task ${e.taskId}, reward ${fmt(e.reward, 2)})`, "", "```", digest(e), "```");
		}
	});
	if (pairs.length === 0) {
		lines.push("", "No run did better than another run here; digests of up to " + `${2 * k} runs follow.`, "");
		for (const e of valid.slice(0, 2 * k)) {
			lines.push("", `### ${label(e)} (task ${e.taskId}, reward ${fmt(e.reward, 2)})`, "", "```", digest(e), "```");
		}
	}
	return `${lines.join("\n")}\n`;
}
