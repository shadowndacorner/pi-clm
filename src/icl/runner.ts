// pi-native piece of the facebookresearch/context-language-models port (fork of @lolipopshock/pi-clm).
// See docs/icl.md for the task contract and provenance.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Episode, episode } from "./episode.ts";
import { run } from "./process.ts";
import { newestSessionFile, parseSession, stepDigest } from "./session.ts";
import type { TaskSource } from "./tasks.ts";

export type CostMetric = "usd" | "tokens";

export interface RunnerOptions {
	/** Path of the plugin root (the `-e` argument for the episode run). */
	extensionRoot: string;
	/** pi binary to run; default: "pi" resolved from PATH. */
	pi?: string;
	/** Agent model as provider/id passed to pi (--model). */
	model?: string;
	/** Extra args forwarded verbatim to every episode run. */
	extraArgs?: string[];
	/** Cost metric to report; "auto" prefers usd when the provider reports it. */
	costMetric?: CostMetric;
	/** Per-episode timeout in milliseconds. Default 30 minutes. */
	timeoutMs?: number;
	/** Keep (true) or delete (default) the per-episode work directories. */
	keepWorkDirs?: boolean;
}

function safeId(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "task";
}

function buildRunnerSpec(
	options: RunnerOptions,
	skillDir: string | null,
	prompt: string,
	sessionDir: string,
): {
	args: string[];
	env: Record<string, string>;
} {
	// -ne: disable extension discovery/built-in extensions — the episode only
	// gets this plugin (explicit -e still loads) and none of the host's globals,
	// so episodes are reproducible on any machine.
	const args = ["-ne", "-e", options.extensionRoot, "-p", "--mode", "text", "--session-dir", sessionDir];
	if (options.model) args.push("--model", options.model);
	args.push(...(options.extraArgs ?? []));
	// The steering document is how a skill reaches the agent: appended to the
	// system prompt; the protocol text around it stays unchanged. For the
	// incumbent "base" the variable is forced empty so a stray value from the
	// invoking shell cannot leak a skill into an unskilled episode.
	const env: Record<string, string> = { PI_CLM_STEERING: skillDir ? `${skillDir}/SKILL.md` : "" };
	return { args: [...args, "--", prompt], env };
}

/**
 * Run one episode: a real `pi -e <plugin> -p <task prompt>` session in the
 * task's fresh work directory, with the candidate's SKILL.md injected as the
 * plugin's steering document (PI_CLM_STEERING), grading via TaskSource.grade,
 * and cost/trajectory extracted from the pi session JSONL.
 */
export class PiRunner {
	private readonly workRoot: string;

	constructor(readonly options: RunnerOptions) {
		this.workRoot = join(tmpdir(), "pi-clm-episodes");
	}

	async runTask(
		source: TaskSource,
		taskId: string,
		/** Skill directory containing SKILL.md, or null for the incumbent "base". */
		skillDir: string | null,
		outDir: string,
		rep: number,
	): Promise<Episode> {
		const episodeTag = `${safeId(taskId)}__r${rep}`;
		const sessionDir = join(outDir, episodeTag);
		await mkdir(sessionDir, { recursive: true });
		await mkdir(this.workRoot, { recursive: true });
		const workDir = await mkdtemp(join(this.workRoot, `${episodeTag}-`));
		let failure: string | null = null;
		try {
			try {
				await source.prepare(taskId, workDir);
			} catch (e) {
				throw new Error(`setup failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			const prompt = await source.prompt(taskId);
			const spec = buildRunnerSpec(this.options, skillDir, prompt, sessionDir);
			const timeoutMs = this.options.timeoutMs ?? 30 * 60_000;
			const res = await run(this.options.pi ?? "pi", spec.args, workDir, timeoutMs, spec.env);
			if (res.timedOut) throw new Error(`episode timed out after ${timeoutMs} ms`);
			// A pi process failure is an ungraded episode (missing, not zero): the
			// gate reruns it. Only TaskSource.grade decides reward.
			const sessionFile = await newestSessionFile(sessionDir);
			if (!sessionFile) {
				throw new Error(
					`no pi session written (exit ${res.code})${res.stderr ? `: ${res.stderr.slice(0, 400)}` : ""}`,
				);
			}
			const facts = await parseSession(sessionFile);
			const graded = await source.grade(taskId, workDir);
			const metric: CostMetric | "auto" = this.options.costMetric ?? "auto";
			let cost: number | null;
			let costMetric: string | null;
			if (metric === "tokens") {
				cost = facts.totalTokens > 0 ? facts.totalTokens : null;
				costMetric = cost === null ? null : "tokens";
			} else if (facts.usd !== null && facts.usd > 0) {
				cost = facts.usd;
				costMetric = "usd";
			} else if (metric === "auto" && facts.totalTokens > 0) {
				cost = facts.totalTokens;
				costMetric = "tokens";
			} else {
				cost = null;
				costMetric = null;
			}
			return episode({
				taskId,
				rep,
				reward: graded?.reward ?? null,
				cost: graded?.reward === null ? null : cost,
				costMetric: graded?.reward === null ? null : costMetric,
				trajectoryPath: sessionFile,
				extra: {
					turns: facts.turns,
					contextEdits: facts.contextEdits,
					gradeDetail: graded?.detail ?? null,
					piExit: res.code,
					digest: stepDigest(facts.steps),
				},
			});
		} catch (e) {
			failure = e instanceof Error ? e.message : String(e);
			return episode({ taskId, rep, error: failure });
		} finally {
			if (!this.options.keepWorkDirs && failure === null) {
				await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}
}
