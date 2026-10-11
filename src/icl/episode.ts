/**
 * One evaluated run: a task attempted by the agent under one skill.
 *
 * Mirrors clm_icl.tasks.Episode (facebookresearch/context-language-models):
 * reward is the grade (null / ungraded means the episode produced no grade —
 * it is missing, not zero), cost is what the episode spent, in costMetric units.
 */

export interface Episode {
	taskId: string;
	rep: number;
	reward: number | null;
	cost: number | null;
	costMetric: string | null;
	/** Path to the raw pi session JSONL, kept for later debugging. */
	trajectoryPath: string | null;
	error: string | null;
	extra: Record<string, unknown> | null;
}

export function episode(input: {
	taskId: string;
	rep: number;
	reward?: number | null;
	cost?: number | null;
	costMetric?: string | null;
	trajectoryPath?: string | null;
	error?: string | null;
	extra?: Record<string, unknown> | null;
}): Episode {
	return {
		taskId: input.taskId,
		rep: input.rep,
		reward: input.reward ?? null,
		cost: input.cost ?? null,
		costMetric: input.costMetric ?? null,
		trajectoryPath: input.trajectoryPath ?? null,
		error: input.error ?? null,
		extra: input.extra ?? null,
	};
}

/** Graded (any reward, including 0) — final. Ungraded or errored — rerun on resume. */
export function isValidEpisode(e: Episode): boolean {
	return e.reward !== null && e.error === null;
}

export function episodeToDict(e: Episode): Record<string, unknown> {
	return {
		task_id: e.taskId,
		rep: e.rep,
		reward: e.reward,
		cost: e.cost,
		cost_metric: e.costMetric,
		trajectory_path: e.trajectoryPath,
		error: e.error,
		extra: e.extra,
	};
}

export function episodeFromDict(value: unknown): Episode {
	const d = (value ?? {}) as Record<string, unknown>;
	return episode({
		taskId: String(d["task_id"] ?? ""),
		rep: Number(d["rep"] ?? 0),
		reward:
			d["reward"] === null || d["reward"] === undefined || d["reward"] === "" ? null : Number(d["reward"]),
		cost: d["cost"] === null || d["cost"] === undefined ? null : Number(d["cost"]),
		costMetric:
			d["cost_metric"] === null || d["cost_metric"] === undefined || d["cost_metric"] === ""
				? null
				: String(d["cost_metric"]),
		trajectoryPath: (d["trajectory_path"] as string | null) ?? null,
		error: (d["error"] as string | null) ?? null,
		extra: (d["extra"] ?? null) as Record<string, unknown> | null,
	});
}
