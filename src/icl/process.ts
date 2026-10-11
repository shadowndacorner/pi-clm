// pi-native piece of the facebookresearch/context-language-models port (fork of @lolipopshock/pi-clm).
// See docs/icl.md for the task contract and provenance.
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Spawn a process, capture output, SIGKILL on timeout. */
export function run(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	env: Record<string, string | undefined> = {},
	extra: { stdin?: string } = {},
): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
		} catch (err) {
			resolvePromise({ code: 127, stdout: "", stderr: String(err), timedOut: false });
			return;
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		let stdout = "";
		let stderr = "";
		const cap = 8 * 1024 * 1024;
		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < cap) stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < cap) stderr += d.toString();
		});
		child.stdin?.on("error", () => undefined);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolvePromise({ code: 127, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, stdout, stderr, timedOut });
		});
		child.stdin?.end(extra.stdin ?? "");
	});
}

/** Run a setup.sh / grade.sh script with bash inside workDir. */
export function runScript(name: string, taskDir: string, workDir: string, timeoutMs: number): Promise<RunResult> {
	return run("bash", [join(taskDir, name)], workDir, timeoutMs);
}
