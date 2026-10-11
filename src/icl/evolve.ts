import { existsSync as fsExistsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Episode, episodeFromDict, episodeToDict, isValidEpisode } from "./episode.ts";
import { diffSe, type Score, gate, pareto, pick, score } from "./gate.ts";
import { buildNote } from "./note.ts";
import { loadProposerSystemPrompt, parseProposal, piProposer, userMessage } from "./proposer.ts";
import { PiRunner, type RunnerOptions } from "./runner.ts";
import type { TaskSource } from "./tasks.ts";

/** In-context skill evolution for CLM, pi edition. Port of clm_icl.evolve.py.
 *
 * Each round:
 *   1. run the current skill (the incumbent) on the training tasks;
 *   2. build a contrastive note from better vs worse runs of the same task;
 *   3. ask a proposer model for N candidate skills (SKILL.md);
 *   4. validate them (malformed candidates are dropped, never repaired);
 *   5. evaluate every valid candidate on the development tasks;
 *   6. keep the best candidate if it passes the gate against the incumbent.
 *
 * The proposer only sees training rollouts. Selection uses the development
 * tasks, which default to the training tasks when no separate set is given.
 * All state lives in the run directory; running the same command again resumes
 * where it stopped, reusing finished episodes and proposals.
 */

const BASE = "base";

function log(msg: string): void {
	process.stderr.write(`[pi-clm ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

interface SkillInfo {
	round?: number;
	parent?: string | null;
	status?: string;
	dev?: Record<string, unknown>;
	gate?: string;
}

export interface EvolutionOptions {
	train: TaskSource;
	dev?: TaskSource | null;
	proposerCall?: (system: string, user: string) => Promise<string>;
	nCandidates?: number;
	reps?: number;
	nPairs?: number;
	workers?: number;
	patience?: number;
	initSkill?: string | null;
	runner: PiRunner;
}

export interface EvolutionState {
	incumbent: string;
	round: number;
	noImprove: number;
	skills: Record<string, SkillInfo>;
	history: unknown[];
	devEqualsTrain?: boolean;
	frontier?: string[];
}

function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
	/** Bounded-concurrency map, matching upstream's ThreadPoolExecutor(workers). */
	return new Promise((resolvePromise) => {
		const results: R[] = new Array(items.length);
		let next = 0;
		let done = 0;
		const launch = (): void => {
			if (next >= items.length) {
				if (done === items.length) resolvePromise(results);
				return;
			}
			const i = next++;
			fn(items[i]!)
				.then((r) => {
					results[i] = r;
				})
				.finally(() => {
					done++;
					launch();
				});
		};
		for (let i = 0; i < Math.max(1, limit) && next < items.length; i++) launch();
		if (items.length === 0) resolvePromise([]);
	});
}

export class Evolution {
	readonly dir: string;
	readonly train: TaskSource;
	readonly dev: TaskSource;
	readonly devSplit: "dev" | "train";
	readonly nCandidates: number;
	readonly reps: number;
	readonly nPairs: number;
	readonly workers: number;
	readonly patience: number;
	readonly runner: PiRunner;
	private readonly proposerCall: (system: string, user: string) => Promise<string>;
	state!: EvolutionState;

	constructor(
		runDir: string,
		options: EvolutionOptions,
	) {
		this.dir = runDir;
		this.train = options.train;
		this.dev = options.dev ?? options.train;
		this.devSplit = options.dev ? "dev" : "train";
		this.proposerCall =
			options.proposerCall ??
			(async (system, user) => {
				"reachable only when no proposerCall is configured";
				throw new Error("no proposer configured");
			});
		this.nCandidates = options.nCandidates ?? 4;
		this.reps = options.reps ?? 1;
		this.nPairs = options.nPairs ?? 5;
		this.workers = Math.max(1, options.workers ?? 1);
		this.patience = options.patience ?? 0;
		this.runner = options.runner;
	}

	async init(initSkill?: string | null): Promise<void> {
		await mkdir(join(this.dir, "skills"), { recursive: true });
		await this.loadState();
		this.state.devEqualsTrain = !optionsDev(this);
		if (!optionsDev(this)) {
			log("WARNING: no dev tasks given; selection uses the training tasks; pass --dev-tasks for an unbiased gate");
		}
		await this.saveState();
		if (!(BASE in this.state.skills)) {
			if (initSkill) {
				const src = (await stat(initSkill)).isDirectory() ? initSkill : dirnameOf(initSkill);
				await cp(src, join(this.dir, "skills", BASE), { recursive: true, force: true });
			}
			this.state.skills[BASE] = { round: 0, parent: null, status: "incumbent" };
			await this.saveState();
		}
	}

	private async loadState(): Promise<void> {
		const p = join(this.dir, "state.json");
		if (await exists(p)) {
			this.state = JSON.parse(await readFile(p, "utf8")) as EvolutionState;
			return;
		}
		this.state = { incumbent: BASE, round: 0, noImprove: 0, skills: {}, history: [] };
	}

	private async saveState(): Promise<void> {
		const p = join(this.dir, "state.json.tmp");
		await writeFile(p, `${JSON.stringify(this.state, null, 1)}\n`, "utf8");
		await rm(join(this.dir, "state.json"), { force: true });
		await copyFile(p, join(this.dir, "state.json"));
		await rm(p, { force: true });
	}

	skillDir(sid: string): string | null {
		const p = join(this.dir, "skills", sid, "SKILL.md");
		return existsSync(p) ? join(this.dir, "skills", sid) : null;
	}

	async skillText(sid: string): Promise<string> {
		const d = this.skillDir(sid);
		return d ? await readFile(join(d, "SKILL.md"), "utf8") : "";
	}

	// -- running tasks ---------------------------------------------------------

	private async episode(split: string, source: TaskSource, sid: string, tid: string, rep: number): Promise<Episode> {
		const cache = join(this.dir, "episodes", split, sid, `${tid}__r${rep}.json`);
		if (await exists(cache)) {
			// A graded episode (any reward, including 0) is final. An ungraded one
			// (crash, infrastructure error) is run again.
			const cached = episodeFromDict(JSON.parse(await readFile(cache, "utf8")));
			if (isValidEpisode(cached)) return cached;
		}
		let ep: Episode;
		try {
			ep = await this.runner.runTask(source, tid, this.skillDir(sid), join(this.dir, "trials", split, sid), rep);
		} catch (e) {
			// a broken task must not stop the loop
			ep = { taskId: tid, rep, reward: null, cost: null, costMetric: null, trajectoryPath: null, error: `${e instanceof Error ? e.name : "Error"}: ${String(e)}`, extra: null };
		}
		await mkdir(join(cache, ".."), { recursive: true });
		await writeFile(cache, `${JSON.stringify(episodeToDict(ep), null, 1)}\n`, "utf8");
		return ep;
	}

	private async evaluate(split: string, source: TaskSource, sids: string[]): Promise<Map<string, Episode[]>> {
		const jobs: [string, string, number][] = [];
		for (const sid of sids) for (const tid of source.taskIds()) for (let rep = 0; rep < this.reps; rep++) jobs.push([sid, tid, rep]);
		log(`${split}: ${jobs.length} episodes for ${sids.join(", ")}`);
		const eps = await mapLimit(jobs, this.workers, (job) => this.episode(split, source, job[0], job[1], job[2]));
		const out = new Map<string, Episode[]>(sids.map((s) => [s, []]));
		jobs.forEach((job, i) => {
			out.get(job[0])!.push(eps[i]!);
		});
		return out;
	}

	async devScore(sid: string): Promise<Score> {
		const info = this.state.skills[sid] ?? {};
		const existing = info.dev;
		const existingOk = existing && completeShaped(existing);
		if (!existingOk) {
			const episodes = (await this.evaluate(this.devSplit, this.dev, [sid])).get(sid)!;
			const s = score(episodes);
			this.state.skills[sid] = { ...info, dev: asDictScore(s) };
			await this.saveState();
			return s;
		}
		return fromDictScore(existing!);
	}

	// -- one round -------------------------------------------------------------

	async runRound(k: number): Promise<unknown> {
		const inc = this.state.incumbent;
		const rdir = join(this.dir, "rounds", `r${k}`);
		await mkdir(rdir, { recursive: true });
		const incScore = await this.devScore(inc);

		// 1-2. rollouts of the incumbent on the training tasks, and the note
		const trainEps = (await this.evaluate("train", this.train, [inc])).get(inc)!;
		const labels = new Map(trainEps.map((e, i) => [e, `E${i + 1}`]));
		const note = buildNote(trainEps, (e) => this.train.digest(e), { k: this.nPairs, labels });
		await writeFile(join(rdir, "note.md"), note, "utf8");

		// 3-4. propose and validate
		const respPath = join(rdir, "proposer_response.txt");
		if (!(await exists(respPath))) {
			const system = await loadProposerSystemPrompt(this.nCandidates);
			const user = userMessage(await this.skillText(inc), note, this.train.describe());
			await writeFile(join(rdir, "proposer_request.txt"), user, "utf8");
			log(`round ${k}: asking the proposer for ${this.nCandidates} candidates`);
			try {
				const resp = await this.proposerCall(system, user);
				await writeFile(respPath, resp, "utf8");
			} catch (e) {
				// stop without finishing the round; a rerun retries
				const message = e instanceof Error ? e.message : String(e);
				await writeFile(join(rdir, "proposer_error.txt"), `${message}\n`, "utf8");
				throw new Error(
					`round ${k}: proposer call failed (${e instanceof Error ? e.name : "Error"}); see ${join(rdir, "proposer_error.txt")}. Rerun to retry.`,
				);
			}
		}
		const prop = parseProposal(await readFile(respPath, "utf8"), this.nCandidates);
		await writeFile(join(rdir, "analysis.md"), `${prop.analysis}\n`, "utf8");
		const cands: string[] = [];
		const known = new Map<string, string>();
		for (const sid of Object.keys(this.state.skills)) {
			if (this.skillDir(sid) && !sid.startsWith(`r${k}-`)) {
				known.set((await this.skillText(sid)).trim(), sid);
			}
		}
		for (const [i, pair] of prop.skills.entries()) {
			const [slug, text] = pair;
			const prior = known.get(text.trim());
			if (prior) {
				prop.rejected.push(`skill ${slug}: same text as ${prior}`);
				continue;
			}
			const sid = `r${k}-${i + 1}-${slug}`;
			const d = join(this.dir, "skills", sid);
			await mkdir(d, { recursive: true });
			await writeFile(join(d, "SKILL.md"), text, "utf8");
			this.state.skills[sid] ??= { round: k, parent: inc, status: "candidate" };
			cands.push(sid);
		}
		log(`round ${k}: ${cands.length} valid candidates, ${prop.rejected.length} rejections`);

		// 5. evaluate candidates on the development tasks
		const todo = cands.filter((sid) => {
			const dev = this.state.skills[sid]?.dev;
			return !dev || !completeShaped(dev);
		});
		if (todo.length > 0) {
			const evalResults = await this.evaluate(this.devSplit, this.dev, todo);
			for (const [sid, eps] of evalResults) {
				this.state.skills[sid] = { ...this.state.skills[sid], dev: asDictScore(score(eps)) };
			}
			await this.saveState();
		}

		// 6. gate against the incumbent
		const results: Record<string, unknown>[] = [];
		const passing: [string, Score][] = [];
		for (const sid of cands) {
			const s = fromDictScore(this.state.skills[sid]!.dev!);
			const [ok, why] = gate(s, incScore);
			this.state.skills[sid] = {
				...this.state.skills[sid],
				status: ok ? "passed" : "rejected",
				gate: why,
			};
			results.push({ skill: sid, ...asDictScore(s), passed: ok, reason: why });
			if (ok) passing.push([sid, s]);
		}
		const winner = passing.length ? pick(passing) : null;
		if (winner) {
			this.state.skills[inc]!.status = "retired";
			this.state.skills[winner]!.status = "incumbent";
			this.state.incumbent = winner;
			this.state.noImprove = 0;
		} else {
			this.state.noImprove += 1;
		}
		const rec = {
			round: k,
			incumbentBefore: inc,
			incumbentScore: asDictScore(incScore),
			candidates: results,
			rejectedAtValidation: prop.rejected,
			winner,
			incumbentAfter: this.state.incumbent,
		};
		await writeFile(join(rdir, "gate.json"), `${JSON.stringify(rec, null, 1)}\n`, "utf8");
		this.state.history.push(rec);
		this.state.round = k;
		await this.saveState();
		log(`round ${k}: ` + (winner ? `new incumbent ${winner}` : `kept ${inc}`));
		return rec;
	}

	async run(rounds: number): Promise<string> {
		const start = this.state.round + 1;
		for (let k = start; k <= rounds; k++) {
			if (this.patience && this.state.noImprove >= this.patience) {
				log(`stopping: ${this.patience} rounds without improvement`);
				break;
			}
			await this.runRound(k);
		}
		const scores: Record<string, Score> = {};
		for (const [sid, info] of Object.entries(this.state.skills)) {
			if (info.dev) scores[sid] = fromDictScore(info.dev);
		}
		this.state.frontier = pareto(scores);
		await this.saveState();
		const best = this.state.incumbent;
		const out = join(this.dir, "best_skill");
		await rm(out, { recursive: true, force: true });
		const bestDir = this.skillDir(best);
		if (bestDir) await cp(bestDir, out, { recursive: true });
		log(`done: incumbent ${best} acc ${scores[best]?.acc ?? "-"}; frontier ${JSON.stringify(this.state.frontier)}`);
		return best;
	}
}

// helpers -------------------------------------------------------------------

function dirnameOf(p: string): string {
	return p.replace(/\/[^/]*$/, "") || "/";
}

async function exists(p: string): Promise<boolean> {
	return await stat(p)
		.then(() => true)
		.catch(() => false);
}

function existsSync(p: string): boolean {
	return fsExistsSync(p);
}

function completeShaped(dev: Record<string, unknown>): boolean {
	if (!dev || typeof dev !== "object") return false;
	const s = fromDictScore(dev);
	return s.n > 0 && s.nValid === s.n;
}

function asDictScore(s: Score): Record<string, unknown> {
	return {
		n: s.n,
		n_valid: s.nValid,
		acc: s.acc,
		cost: s.cost,
		cost_metric: s.costMetric,
		task_rewards: s.taskRewards,
	};
}

function fromDictScore(dict: Record<string, unknown>): Score {
	return {
		n: Number(dict["n"] ?? 0),
		nValid: Number(dict["n_valid"] ?? 0),
		acc: dict["acc"] === null || dict["acc"] === undefined ? null : Number(dict["acc"]),
		cost: dict["cost"] === null || dict["cost"] === undefined ? null : Number(dict["cost"]),
		costMetric:
			dict["cost_metric"] === null || dict["cost_metric"] === undefined || dict["cost_metric"] === ""
				? null
				: String(dict["cost_metric"]),
		taskRewards: (dict["task_rewards"] ?? {}) as Record<string, number>,
	};
}

function optionsDev(evo: Evolution): boolean {
	return evo.devSplit === "dev";
}


