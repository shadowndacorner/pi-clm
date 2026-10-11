import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./process.ts";

/**
 * The proposer: ask a model for candidate skills, then validate the response.
 * Port of clm_icl.propose.py, with the litellm call replaced by a real pi run
 * (`pi -p --model <proposer-model>`) so the loop uses exactly the providers the
 * user already configured in pi — hosted or local, no separate credentials.
 *
 * The proposer is any chat model. Assisted evolution uses a stronger model than
 * the agent; self-evolution passes the agent's own model. It only reads
 * training rollouts, never evaluation data.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "proposer-prompt.md");

export interface PiCliOptions {
	pi?: string;
	model?: string;
	extraArgs?: string[];
	timeoutMs?: number;
	cwd?: string;
}

export async function systemPromptText(): Promise<string> {
	return await readFile(PROMPT_PATH, "utf8");
}

export function systemPrompt(nCandidates: number, raw?: string): string {
	return (raw ?? "").replace(/\{N\}/g, String(nCandidates));
}

export function userMessage(currentSkill: string, note: string, taskDescription: string): string {
	const parts = [
		"## TASKS",
		taskDescription.trim() || "(no task description provided)",
		"",
		"## CURRENT SKILL (SKILL.md; the text you are improving on)",
		currentSkill.trim() || "(none: the agent currently runs without a skill)",
		"",
		"## NOTE ON THE CURRENT SKILL'S ROLLOUTS (evidence)",
		note,
		"",
		"## YOUR TASK",
		"Follow the loop. Emit the ANALYSIS block, then the SKILL blocks per the OUTPUT " +
			"CONTRACT. Nothing else.",
	];
	return parts.join("\n");
}

export interface Proposal {
	analysis: string;
	skills: [string, string][];
	rejected: string[];
}

// The slug may be followed by three or more '>' (the template itself renders ">>>>").
const SKILL_RE = /<<<SKILL name=([^\n>]+?)>{3,}\s*\n([\s\S]*?)\n<<<END>>>/g;
const ANALYSIS_RE = /<<<ANALYSIS>{3,}\s*\n([\s\S]*?)\n<<<END>>>/;
// Evidence citation: an episode id (E3) or a step / message index.
const CITE_RE = /\bE\d+\b|\bstep\s*\d+|\bmsg\s*\d+/i;

export function parseProposal(content: string, maxSkills: number | null = null): Proposal {
	/** Parse and validate a proposer response. Reasoning traces are removed first
	 * since they can contain draft blocks. A skill is kept if it has YAML
	 * frontmatter with name and description, a non-empty body, and cites evidence
	 * in its description or the start of its body. Malformed skills are dropped
	 * and listed in rejected; they are never repaired. */
	let text = String(content ?? "");
	text = text.replace(/<\|?think(?:ing)?\|?>[\s\S]*?<\/?\|?think(?:ing)?\|?>/g, "");
	text = text.replace(/^[\s\S]*?<\/think>/, "");
	const p: Proposal = { analysis: "", skills: [], rejected: [] };
	const m = ANALYSIS_RE.exec(text);
	p.analysis = m ? m[1]!.trim() : "";
	if (!p.analysis) p.rejected.push("ANALYSIS block missing or empty");
	const seen = new Set<string>();
	const matches = [...text.matchAll(SKILL_RE)];
	if (matches.length === 0) {
		p.rejected.push(`no parseable <<<SKILL ...>>> blocks (${text.length} chars)`);
	}
	for (const match of matches) {
		const name = match[1]!.trim();
		const body = match[2]!.trim();
		const fm = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(body);
		if (!fm) {
			p.rejected.push(`skill ${name}: no YAML frontmatter`);
			continue;
		}
		const front = fm[1]!;
		const bodyText = fm[2]!.trim();
		if (!front.includes("name:") || !front.includes("description:")) {
			p.rejected.push(`skill ${name}: frontmatter missing name/description`);
			continue;
		}
		if (!bodyText) {
			p.rejected.push(`skill ${name}: empty body`);
			continue;
		}
		const desc = front
			.split("\n")
			.find((ln) => ln.trim().startsWith("description:"));
		if (!CITE_RE.test(`${desc ?? ""} ${bodyText.slice(0, 400)}`)) {
			p.rejected.push(`skill ${name}: cites no episode or step`);
			continue;
		}
		let slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";
		while (seen.has(slug)) slug = `${slug}-b`;
		seen.add(slug);
		// Full block (frontmatter + body) is stored — a SKILL.md must be a valid
		// skill file by itself, mirroring upstream.
		p.skills.push([slug, `${body}\n`]);
	}
	if (maxSkills !== null && p.skills.length > maxSkills) {
		for (const [s] of p.skills.slice(maxSkills)) {
			p.rejected.push(`skill ${s}: over the ${maxSkills}-candidate limit`);
		}
		p.skills = p.skills.slice(0, maxSkills);
	}
	return p;
}

/** Call the proposer through pi, using the configured provider/model. */
export async function piProposer(
	system: string,
	user: string,
	options: PiCliOptions = {},
): Promise<string> {
	const pi = options.pi ?? "pi";
	// -ne: no extensions; the proposer is a plain model call.
	const args: string[] = ["-ne", "-p", "--mode", "text", "--no-tools", "--no-session"];
	if (options.model) args.push("--model", options.model);
	args.push(...(options.extraArgs ?? []));
	args.push("--system-prompt", system);
	// The note may be tens of KB; pass it through a temp file referenced with
	// pi's @file attach syntax to stay under argument-size limits of every OS.
	const tmp = join(tmpdir(), `pi-clm-proposer-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
	await writeFile(tmp, user, "utf8");
	try {
		const res = await run(pi, [...args, `@${tmp}`], options.cwd ?? process.cwd(), options.timeoutMs ?? 15 * 60_000, {});
		if (res.timedOut) throw new Error(`proposer timed out after ${options.timeoutMs ?? 900_000} ms`);
		if (res.code !== 0 && !res.stdout.trim()) {
			throw new Error(`proposer pi call failed (exit ${res.code}): ${res.stderr.slice(0, 600)}`);
		}
		return res.stdout;
	} finally {
		await rm(tmp, { force: true }).catch(() => undefined);
	}
}

export async function loadProposerSystemPrompt(nCandidates: number): Promise<string> {
	return systemPrompt(nCandidates, await systemPromptText());
}

export { readFile };
