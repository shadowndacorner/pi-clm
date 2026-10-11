#!/usr/bin/env -S npx -y tsx
/**
 * pi-clm-evolve: evolve a context-management skill (SKILL.md) from the agent's
 * own pi rollouts. Port of `python -m clm_icl.evolve` to the plugin runtime.
 *
 * Rerun the same command to resume: graded episodes, proposals and scores are
 * reused; episodes that ended without a grade are run again.
 *
 *   npx tsx bin/pi-clm-evolve.ts --tasks tasks/train --dev-tasks tasks/dev \
 *     --proposer-model anthropic/claude-sonnet-4.5 --rounds 5 --candidates 4 \
 *     --reps 2 --workers 8 --out runs/evo1
 *
 * Task contract (see docs/icl.md): a task directory with TASK.md (the prompt),
 * optional files/ (seeded work dir), setup.sh and grade.sh.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Evolution } from "../src/icl/evolve.ts";
import { type CostMetric, PiRunner } from "../src/icl/runner.ts";
import { loadDirTaskSource, type DirTaskSource } from "../src/icl/tasks.ts";
import { piProposer } from "../src/icl/proposer.ts";

const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
	tasks: string | null;
	devTasks: string | null;
	taskDescription: string;
	piBin: string;
	ext: string;
	model: string | null;
	agentArg: string[];
	proposerModel: string | null;
	proposerArg: string[];
	costMetric: CostMetric;
	rounds: number;
	candidates: number;
	reps: number;
	pairs: number;
	workers: number;
	patience: number;
	initSkill: string | null;
	out: string | null;
	timeoutS: number;
	help: boolean;
}

function usage(): void {
	process.stdout.write(
		`pi-clm-evolve — evolve a CLM steering skill from the agent's own rollouts

usage: npx tsx bin/pi-clm-evolve.ts [options]

tasks:
  --tasks PATH            training tasks: a task dir, a dir of task dirs, or a
                          file listing task dirs (each with TASK.md; optional
                          files/, setup.sh, grade.sh)
  --dev-tasks PATH        selection tasks (default: --tasks; not unbiased)
  --task-description TEXT|FILE   shown to the proposer

agent:
  --pi PATH               pi binary (default: pi on PATH)
  --ext PATH              plugin root to run episodes with (-e); default: this package
  --model PROVIDER/ID     agent model for pi (--model); default: pi's default
  --agent-arg ARG         extra pi argument, repeatable
  --cost-metric usd|tokens|auto   (auto: usd when the provider reports it)
  --timeout-s SECONDS     per-episode timeout (default 1800)

proposer:
  --proposer-model PROVIDER/ID   default: pi's default model; pass the agent's
                          model for self-evolution
  --proposer-arg ARG      extra pi argument for the proposer, repeatable

loop:
  --rounds N              (default 3)
  --candidates N          (default 4)
  --reps N                runs per task and skill (default 1)
  --pairs N               contrastive pairs in the note (default 5)
  --workers N             episodes run in parallel (default 1)
  --patience N            stop after N rounds without a new incumbent (0: never)
  --init-skill DIR|SKILL.md   starting skill (default: none)
  --out DIR               run directory (required)
`,
	);
}

function parseArgs(argv: string[]): Args {
	const a: Args = {
		tasks: null,
		devTasks: null,
		taskDescription: "",
		piBin: "pi",
		ext: EXTENSION_ROOT,
		model: null,
		agentArg: [],
		proposerModel: null,
		proposerArg: [],
		costMetric: "usd",
		rounds: 3,
		candidates: 4,
		reps: 1,
		pairs: 5,
		workers: 1,
		patience: 0,
		initSkill: null,
		out: null,
		timeoutS: 1800,
		help: false,
	};
	const need = (missing: string): string => {
		throw new Error(`missing value for ${missing}`);
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		const val = (): string => argv[++i] ?? need(flag);
		switch (flag) {
			case "--tasks": a.tasks = val(); break;
			case "--dev-tasks": a.devTasks = val(); break;
			case "--task-description": a.taskDescription = val(); break;
			case "--pi": case "--pi-bin": a.piBin = val(); break;
			case "--ext": case "--extension": a.ext = val(); break;
			case "--model": a.model = val(); break;
			case "--agent-arg": a.agentArg.push(val()); break;
			case "--proposer-model": a.proposerModel = val(); break;
			case "--proposer-arg": a.proposerArg.push(val()); break;
			case "--cost-metric": {
				const v = val();
				if (v === "usd" || v === "tokens" || v === "auto") a.costMetric = v === "auto" ? "usd" : v;
				else throw new Error(`--cost-metric must be usd|tokens|auto, got ${v}`);
				break;
			}
			case "--rounds": a.rounds = Number(val()); break;
			case "--candidates": a.candidates = Number(val()); break;
			case "--reps": a.reps = Number(val()); break;
			case "--pairs": a.pairs = Number(val()); break;
			case "--workers": a.workers = Number(val()); break;
			case "--patience": a.patience = Number(val()); break;
			case "--init-skill": a.initSkill = val(); break;
			case "--out": a.out = val(); break;
			case "--timeout-s": a.timeoutS = Number(val()); break;
			case "-h": case "--help": a.help = true; break;
			default: throw new Error(`unknown flag: ${flag}`);
		}
	}
	return a;
}

async function exists(p: string): Promise<boolean> {
	return await stat(p)
		.then(() => true)
		.catch(() => false);
}

async function main(argv: string[]): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (e) {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n\n`);
		usage();
		return 2;
	}
	if (args.help) {
		usage();
		return 0;
	}
	if (!args.tasks) throw new Error("--tasks is required");
	if (!args.out) throw new Error("--out is required");

	const descriptionIsFile = args.taskDescription.length > 0 && (await exists(args.taskDescription));
	const taskDescription = descriptionIsFile ? await readFile(args.taskDescription, "utf8") : args.taskDescription;
	const train: DirTaskSource = await loadDirTaskSource(args.tasks, taskDescription);
	const dev = args.devTasks ? await loadDirTaskSource(args.devTasks, taskDescription) : null;

	const runner = new PiRunner({
		extensionRoot: args.ext,
		pi: args.piBin,
		model: args.model ?? undefined,
		extraArgs: args.agentArg,
		costMetric: args.costMetric,
		timeoutMs: args.timeoutS * 1000,
	});
	const proposerCall = async (system: string, user: string): Promise<string> =>
		await piProposer(system, user, {
			pi: args.piBin,
			model: args.proposerModel ?? undefined,
			extraArgs: args.proposerArg,
			cwd: args.out ?? process.cwd(),
		});

	const evo = new Evolution(resolve(args.out), {
		train,
		dev,
		proposerCall,
		nCandidates: args.candidates,
		reps: args.reps,
		nPairs: args.pairs,
		workers: args.workers,
		patience: args.patience,
		initSkill: args.initSkill,
		runner,
	});
	await evo.init(args.initSkill);
	await mkdir(args.out, { recursive: true });
	await writeFile(join(args.out, "args.json"), `${JSON.stringify(argv, null, 1)}\n`, "utf8");
	await evo.run(args.rounds);
	return 0;
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((e) => {
		process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	});
