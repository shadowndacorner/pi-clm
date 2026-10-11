#!/usr/bin/env -S npx -y tsx
/**
 * pi-clm-skill: skill lifecycle for the pi-clm fork.
 *
 *   check  run the stop-on-regression eval: a candidate skill against a
 *          baseline (no skill by default) over a shared task set.
 *          exit 0 = no regression; exit 1 = regression; exit 2 = could not
 *          verify (ungraded candidate episode where baseline was graded).
 *
 *   (skill use — winner→daily-driver installation — lands with the wiring task.)
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { episodeToDict, type Episode } from "../src/icl/episode.ts";
import { checkRegression } from "../src/icl/check.ts";
import { type CostMetric, PiRunner } from "../src/icl/runner.ts";
import { loadDirTaskSource, type DirTaskSource } from "../src/icl/tasks.ts";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CheckArgs {
	run: string | null;
	skill: string | null;
	baseline: string | null;
	tasks: string | null;
	pi: string;
	ext: string;
	model: string | null;
	agentArg: string[];
	costMetric: CostMetric;
	reps: number;
	workers: number;
	timeoutS: number;
	out: string | null;
	help: boolean;
}

function usage(): void {
	process.stdout.write(
		`pi-clm-skill — skill lifecycle commands for the pi-clm fork

usage: npx tsx bin/pi-clm-skill.ts check [options]

check (stop-on-regression eval gate):
  --run PATH        evolve run dir: candidate = its incumbent/best_skill
  --skill DIR|SKILL.md   candidate skill (alternative to --run)
  --baseline DIR|SKILL.md|none   baseline skill (default: none = no steering)
  --tasks PATH      shared task set (a dir of task dirs; required)
  --reps N          episodes per task and skill (default 1)
  --workers N       parallel episodes
  --pi PATH         pi binary; --ext PATH plugin root for episodes
  --model PROVIDER/ID     agent model override
  --agent-arg ARG   extra pi args, repeatable
  --cost-metric usd|tokens|auto
  --timeout-s S     per-episode timeout
  --out PATH        report path (default <runDir or .>/check.json)

exit codes: 0 no regression · 1 regression · 2 could not verify
`,
	);
}

function parseArgs(argv: string[]): { mode: string; rest: string[] } {
	const [mode, ...rest] = argv;
	return { mode: mode ?? "", rest };
}

async function exists(p: string): Promise<boolean> {
	return await stat(p)
		.then(() => true)
		.catch(() => false);
}

async function skillName(dir: string): Promise<string> {
	// show the name found inside SKILL.md frontmatter when available
	try {
		const text = await readFile(`${dir}/SKILL.md`, "utf8");
		const m = /^name:\s*(.+)$/m.exec(text);
		if (m) return m[1]!.trim();
	} catch {
		// no SKILL.md — fall back to the directory name
	}
	return dir.split("/").pop() ?? dir;
}

async function resolveSkill(spec: string | null, kind: string): Promise<{ id: string; dir: string | null }> {
	if (!spec || spec === "none") return { id: `${kind}:none`, dir: null };
	const st = await stat(spec);
	const dir = st.isDirectory() ? spec : dirname(spec);
	return { id: await skillName(dir), dir };
}

async function collectEpisodes(
	runner: PiRunner,
	source: DirTaskSource,
	skillDir: string | null,
	outDir: string,
	reps: number,
	workers: number,
): Promise<Episode[]> {
	// episodes are cached by the evolve loop; the check reuses the same cache path
	const jobs: [string, number][] = [];
	for (const tid of source.taskIds()) for (let rep = 0; rep < reps; rep++) jobs.push([tid, rep]);
	const results: Episode[] = [];
	let next = 0;
	async function worker(): Promise<void> {
		while (next < jobs.length) {
			const [tid, rep] = jobs[next++]!;
			const ep = await runner.runTask(source, tid, skillDir, outDir, rep);
			results.push(ep);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, workers) }, worker));
	return results;
}

async function runCheck(rest: string[]): Promise<number> {
	const a: CheckArgs = {
		run: null,
		skill: null,
		baseline: null,
		tasks: null,
		pi: "pi",
		ext: EXTENSION_ROOT,
		model: null,
		agentArg: [],
		costMetric: "usd",
		reps: 1,
		workers: 1,
		timeoutS: 1800,
		out: null,
		help: false,
	};
	const need = (missing: string): string => {
		throw new Error(`missing value for ${missing}`);
	};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i]!;
		const val = (): string => rest[++i] ?? need(flag);
		switch (flag) {
			case "--run": a.run = val(); break;
			case "--skill": a.skill = val(); break;
			case "--baseline": a.baseline = val(); break;
			case "--tasks": a.tasks = val(); break;
			case "--pi": a.pi = val(); break;
			case "--ext": a.ext = val(); break;
			case "--model": a.model = val(); break;
			case "--agent-arg": a.agentArg.push(val()); break;
			case "--cost-metric": {
				const v = val();
				if (v === "usd" || v === "tokens" || v === "auto") a.costMetric = v === "auto" ? "usd" : v;
				else throw new Error(`--cost-metric must be usd|tokens|auto, got ${v}`);
				break;
			}
			case "--reps": a.reps = Number(val()); break;
			case "--workers": a.workers = Number(val()); break;
			case "--timeout-s": a.timeoutS = Number(val()); break;
			case "--out": a.out = val(); break;
			case "-h": case "--help": a.help = true; break;
			default: throw new Error(`unknown flag: ${flag}`);
		}
	}
	if (a.help) {
		usage();
		return 0;
	}
	if (!a.tasks) throw new Error("--tasks is required");
	//.All paths made absolute: the episode runner spawns pi with the work
	// directory as its cwd, so relative paths would resolve differently there.
	if (!a.skill && !a.run) throw new Error("pass --skill or --run (candidate to check)");

	// candidate: explicit --skill, else the run's incumbent
	let candidateDir: string | null;
	let candidateLabel: string;
	if (a.skill) {
		const resolved = await resolveSkill(a.skill, "skill");
		candidateDir = resolved.dir;
		candidateLabel = resolved.id;
	} else {
		const runDir = a.run!;
		const state = JSON.parse(await readFile(`${runDir}/state.json`, "utf8")) as {
			incumbent: string;
			skills: Record<string, unknown>;
		};
		const inc = state.incumbent;
		const best = await exists(`${runDir}/best_skill/SKILL.md`)
			? `${runDir}/best_skill`
			: await exists(`${runDir}/skills/${inc}/SKILL.md`)
				? `${runDir}/skills/${inc}`
				: null;
		if (!best) throw new Error(`run ${runDir}: incumbent ${inc} has no SKILL.md to check`);
		candidateDir = best;
		candidateLabel = `${inc} (from ${runDir})`;
	}
	const baseline = await resolveSkill(a.baseline, "baseline");

	const source = await loadDirTaskSource(a.tasks!);
	const runner = new PiRunner({
		extensionRoot: a.ext,
		pi: a.pi,
		model: a.model ?? undefined,
		extraArgs: a.agentArg,
		costMetric: a.costMetric,
		timeoutMs: a.timeoutS * 1000,
	});
	const outDir = resolve(a.out ? dirname(a.out) : a.run ?? process.cwd());
	process.stderr.write(`[pi-clm-skill] candidate ${candidateLabel}; baseline ${baseline.id}; ${source.taskIds().length} tasks × ${a.reps} reps each\n`);
	const candEps = await collectEpisodes(runner, source, candidateDir, join(outDir, "check", "candidate"), a.reps, a.workers);
	const baseEps = await collectEpisodes(runner, source, baseline.dir, join(outDir, "check", "baseline"), a.reps, a.workers);
	const report = checkRegression(baseline.id, baseEps, candidateLabel, candEps);
	const reportPath = a.out ?? join(outDir, "check.json");
	await (await import("node:fs/promises")).writeFile(
		reportPath,
		`${JSON.stringify({ ...report, episodes: { candidate: candEps.map(episodeToDict), baseline: baseEps.map(episodeToDict) } }, null, 1)}\n`,
		"utf8",
	);
	const gradedTasks = report.tasks.filter((t) => t.candidateMean !== null).length;
	process.stderr.write(
		`[pi-clm-skill] ${gradedTasks}/${report.tasks.length} tasks graded · ` +
			(report.passed
				? "no regression"
				: report.blockedTasks.length
					? `could not verify (blocked: ${report.blockedTasks.join(", ")})`
					: `REGRESSION: ${report.regressions.join("; ")}`) +
			`\n[pi-clm-skill] report: ${reportPath}\n`,
	);
	if (!report.passed) return report.blockedTasks.length ? 2 : 1;
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const { mode, rest } = parseArgs(argv);
	if (!mode || mode === "-h" || mode === "--help") {
		usage();
		return mode && mode !== "" ? 0 : 0;
	}
	switch (mode) {
		case "check": return await runCheck(rest);
		case "use": throw new Error("`skill use` lands with the #2 wiring task");
		default: throw new Error(`unknown command: ${mode} (available: check)`);
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((e) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
