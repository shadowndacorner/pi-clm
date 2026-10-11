// pi-native piece of the facebookresearch/context-language-models port (fork of @lolipopshock/pi-clm).
// See docs/icl.md for the task contract and provenance.
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Episode } from "./episode.ts";
import { runScript } from "./process.ts";

/**
 * Task sources and the pi-native task contract.
 *
 * Mirrors clm_icl.tasks.TaskSource: run one task under one skill and return an
 * Episode. The pi-native contract is a task directory:
 *
 *   <task>/
 *     TASK.md      required  the prompt given to the agent
 *     files/       optional  copied into the fresh work directory
 *     setup.sh     optional  run in the work directory before the episode
 *     grade.sh     optional  run after the episode; exit 0 → reward 1, other
 *                            exit codes → reward 0; or stdout JSON {"reward": x}
 *
 * A task without grade.sh produces an ungraded episode (missing, not zero).
 */
export interface GradeResult {
	reward: number | null;
	detail: string;
}

export interface TaskSource {
	taskIds(): string[];
	/** The prompt text for the task (TASK.md). */
	prompt(taskId: string): Promise<string>;
	/** Fresh work directory for the episode (copied from files/, setup.sh run). */
	prepare(taskId: string, workDir: string): Promise<void>;
	/** Grade the work directory; null = no grade this episode. */
	grade(taskId: string, workDir: string): Promise<GradeResult | null>;
	/** Short text about the tasks for the proposer. */
	describe(): string;
	/** Step-indexed digest of a run for the proposer's note. */
	digest(e: Episode): string;
}

export class DirTaskSource implements TaskSource {
	private constructor(
		readonly tasks: Map<string, string>,
		private readonly descriptionText: string,
		private readonly timeoutMs: number,
	) {}

	static async load(spec: string, description = "", timeoutMs = 15 * 60_000): Promise<DirTaskSource> {
		const st = await stat(spec);
		const dirs: string[] = [];
		if (st.isDirectory()) {
			// A single task dir (has TASK.md) or a directory of task dirs. Task
			// paths are stored ABSOLUTE: scripts (grade.sh) run with the episode
			// work directory as cwd, so a relative path would silently break.
			const entries = await readdir(spec);
			if (entries.includes("TASK.md")) {
				dirs.push(resolve(spec));
			} else {
				for (const e of entries) {
					const p = resolve(spec, e);
					if ((await stat(p)).isDirectory() && (await readdir(p)).includes("TASK.md")) dirs.push(p);
				}
			}
		} else if (st.isFile()) {
			// A file with one task directory per line.
			const lines = (await readFile(spec, "utf8")).split("\n").map((l) => l.trim());
			for (const l of lines) {
				if (!l || l.startsWith("#")) continue;
				const p = isAbsolute(l) ? l : resolve(spec, "..", l);
				if ((await stat(p)).isDirectory()) dirs.push(p);
			}
		}
		if (dirs.length === 0) throw new Error(`no task directories (with TASK.md) under: ${spec}`);
		dirs.sort();
		const descriptionText = description || `User-defined tasks (${dirs.length}): ${dirs.map((d) => basename(d)).join(", ")}`;
		return new DirTaskSource(new Map(dirs.map((d) => [basename(d), d])), descriptionText, timeoutMs);
	}

	taskIds(): string[] {
		return [...this.tasks.keys()].sort();
	}

	/** Absolute task directories, sorted (episode workdirs and graders use these). */
	dirs(): string[] {
		return [...this.tasks.values()].sort();
	}

	async prompt(taskId: string): Promise<string> {
		return await readFile(join(this.tasks.get(taskId)!, "TASK.md"), "utf8");
	}

	async prepare(taskId: string, workDir: string): Promise<void> {
		const task = this.tasks.get(taskId)!;
		const filesDir = join(task, "files");
		const seeded = await stat(filesDir)
			.then((s) => s.isDirectory())
			.catch(() => false);
		if (seeded) await cp(filesDir, workDir, { recursive: true });
		await runScript("setup.sh", task, workDir, this.timeoutMs);
	}

	async grade(taskId: string, workDir: string): Promise<GradeResult | null> {
		const task = this.tasks.get(taskId)!;
		const hasGrade = await stat(join(task, "grade.sh"))
			.then(() => true)
			.catch(() => false);
		if (!hasGrade) return null; // no grader — ungraded episode
		const res = await runScript("grade.sh", task, workDir, this.timeoutMs);
		const detail = (res.stdout + (res.stderr ? `\n[stderr] ${res.stderr}` : "")).trim();
		// stdout JSON {"reward": x} overrides the exit code; reward null = ungraded.
		try {
			const parsed = JSON.parse(res.stdout.trim()) as { reward?: unknown };
			if (parsed && typeof parsed === "object" && "reward" in parsed) {
				const reward = parsed["reward"];
				return { reward: reward === null || reward === undefined ? null : Number(reward), detail };
			}
		} catch {
			// not JSON — fall back to the exit code
		}
		return { reward: res.code === 0 ? 1.0 : 0.0, detail };
	}

	describe(): string {
		return this.descriptionText;
	}

	digest(e: Episode): string {
		return (e.extra?.["digest"] as string | undefined) ?? (e.trajectoryPath ? "(digest unavailable)" : "(no trajectory)");
	}
}

export async function loadDirTaskSource(spec: string, description = "", timeoutMs?: number): Promise<DirTaskSource> {
	return await DirTaskSource.load(spec, description, timeoutMs);
}
