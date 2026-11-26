/**
 * Run the eval/tasks regression set once per arm, serially, and report reward,
 * token cost and the number of accepted context edits per episode.
 *
 *   npx tsx scripts/arm-regression.ts --ext /tmp/clm-base --out runs/regress/base
 *   npx tsx scripts/arm-regression.ts --ext /tmp/clm-cand --out runs/regress/cand
 *
 * Arms differ only by the checked-out extension (`--ext`), so the comparison is
 * validator+guidance+skill vs the previous tip. Episodes run with the air
 * provider extension attached explicitly, because the runner disables
 * extension discovery (-ne) and air is contributed by an extension.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiRunner } from "../src/icl/runner.ts";
import { loadDirTaskSource } from "../src/icl/tasks.ts";

function arg(name: string, def?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const value = i >= 0 ? process.argv[i + 1] : def;
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

async function main(): Promise<number> {
	const ext = arg("ext");
	const out = arg("out");
	const model = arg("model", "air/qwen3.8-flash-next-iq3_s");
	const airExt = arg("air-ext", "/home/claire/inference-setup/pi-air/index.mjs");
	const reps = Number(arg("reps", "1"));
	const timeoutS = Number(arg("timeout-s", "1200"));
	const only = process.argv.includes("--only") ? arg("only") : null;

	// Absolute: pi resolves --session-dir against the episode's working directory,
	// not the runner's, so a relative --out strands the session files.
	const outDir = resolve(out);
	await mkdir(outDir, { recursive: true });
	const source = await loadDirTaskSource(arg("tasks", "eval/tasks"));
	const runner = new PiRunner({
		extensionRoot: ext,
		model,
		extraArgs: ["-e", airExt],
		costMetric: "tokens",
		timeoutMs: timeoutS * 1000,
		keepWorkDirs: true,
	});
	const ids = only ? [only] : source.taskIds();
	for (const taskId of ids) {
		for (let rep = 1; rep <= reps; rep += 1) {
			const e = await runner.runTask(source, taskId, null, outDir, rep);
			const row = {
				taskId,
				rep,
				reward: e.reward ?? null,
				cost: e.cost ?? null,
				turns: e.extra?.turns ?? null,
				contextEdits: e.extra?.contextEdits ?? null,
				error: e.error ?? null,
				trajectory: e.trajectoryPath ?? null,
			};
			await appendFile(join(outDir, "episodes.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
			process.stdout.write(`${taskId} rep${rep}: reward=${row.reward} tokens=${row.cost} turns=${row.turns} contextEdits=${row.contextEdits}${row.error ? ` error=${row.error}` : ""}\n`);
		}
	}
	return 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
	process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
