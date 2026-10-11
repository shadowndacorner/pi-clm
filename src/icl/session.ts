// pi-native piece of the facebookresearch/context-language-models port (fork of @lolipopshock/pi-clm).
// See docs/icl.md for the task contract and provenance.
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * pi session JSONL → cost, turns and a step-indexed digest.
 *
 * pi's session format is append-only JSONL; each line is an entry (`type`:
 * session, message, custom, …; messages carry roles user / assistant /
 * toolResult; assistant content blocks are text / thinking / toolCall).
 * Assistant entries carry provider `usage` (tokens and, when the provider
 * reports it, cost). The digest is the trajectory the proposer reads: one line
 * per step (user message, assistant message with its tool calls, tool result),
 * with per-request input tokens so the proposer can see what filled context at
 * every step — the note asks for levers derived from measured context
 * composition, not from skill prose.
 */

export interface SessionFacts {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** Provider-reported USD over the session; null when not reported. */
	usd: number | null;
	steps: string[];
	/** Number of custom live-context entries (mirrors/projections) recorded. */
	contextEdits: number;
}

interface EntryLine {
	type?: string;
	customType?: string;
	message?: {
		role?: string;
		content?: Array<Record<string, unknown>>;
		usage?: {
			input?: number;
			output?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
	};
}

function textOf(content: Array<Record<string, unknown>> | undefined): string {
	if (!content) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (c["type"] === "text") parts.push(String(c["text"] ?? ""));
		else if (c["type"] === "thinking") parts.push(`(thinking ${String(c["thinking"] ?? "").length} ch)`);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

function toolCallsOf(content: Array<Record<string, unknown>> | undefined): string {
	if (!content) return "";
	const calls: string[] = [];
	for (const c of content) {
		if (c["type"] !== "toolCall") continue;
		const name = String(c["name"] ?? "tool");
		const args = c["arguments"];
		let argsText = "";
		if (args && typeof args === "object") {
			const keys = Object.keys(args as Record<string, unknown>);
			argsText = keys.length ? `(${keys.slice(0, 4).join(",")})` : "()";
		}
		calls.push(`${name}${argsText}`);
	}
	return calls.join(", ");
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function firstText(content: Array<Record<string, unknown>> | undefined): string {
	if (!content) return "(no text)";
	for (const c of content) if (c["type"] === "text") return clip(String(c["text"] ?? "").replace(/\s+/g, " ").trim(), 300);
	return "(no text)";
}

export async function parseSession(sessionPath: string): Promise<SessionFacts> {
	const raw = await readFile(sessionPath, "utf8");
	const facts: SessionFacts = {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		usd: null,
		steps: [],
		contextEdits: 0,
	};
	let usdSeen = false;
	let usdSum = 0;
	let step = 0;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: EntryLine;
		try {
			entry = JSON.parse(line) as EntryLine;
		} catch {
			continue;
		}
		if (entry.type === "custom" && String(entry.customType ?? "").startsWith("live-context")) {
			facts.contextEdits += 1;
			continue;
		}
		const msg = entry.message;
		if (!msg) continue;
		const role = String(msg.role ?? "");
		const usage = msg.usage;
		if (usage) {
			facts.inputTokens += Number(usage.input ?? 0);
			facts.outputTokens += Number(usage.output ?? 0);
			facts.totalTokens += Number(usage.totalTokens ?? 0);
			const total = usage.cost?.total;
			if (typeof total === "number" && total > 0) {
				usdSeen = true;
				usdSum += total;
			}
		}
		if (role === "user") {
			const text = textOf(msg.content);
			if (!text) continue;
			step += 1;
			facts.steps.push(`step ${step} | user | ${clip(text, 300)} | ~in ${usage?.input ?? 0} tok`);
		} else if (role === "assistant") {
			step += 1;
			const tools = toolCallsOf(msg.content);
			const parts = [`step ${step} | assistant`];
			if (tools) parts.push(`tools: ${clip(tools, 200)}`);
			parts.push(clip(textOf(msg.content), 400));
			parts.push(`(${usage ? `in ${usage.input ?? 0} / out ${usage.output ?? 0}` : "usage missing"})`);
			facts.steps.push(parts.join(" | "));
			facts.turns += 1;
		} else if (role === "toolResult") {
			step += 1;
			facts.steps.push(`step ${step} | toolResult | ${firstText(msg.content)}`);
		}
	}
	facts.steps = facts.steps.slice(0, 240);
	facts.usd = usdSeen ? usdSum : null;
	return facts;
}

/** Newest *.jsonl under a session directory (the episode just ran there alone). */
export async function newestSessionFile(dir: string): Promise<string | null> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const sessions = entries.filter((e) => e.endsWith(".jsonl")).sort();
	return sessions.length ? `${dir.replace(/\/$/, "")}/${sessions[sessions.length - 1]}` : null;
}

/** Tail-bounded digest; the note cites step indices from these lines. */
export function stepDigest(steps: string[], maxSteps = 60): string {
	const start = Math.max(0, steps.length - maxSteps);
	const head = start > 0 ? [`… ${start} earlier steps omitted …`, ""] : [];
	return [...head, ...steps.slice(start)].join("\n");
}

export function sessionLabel(sessionPath: string): string {
	return basename(sessionPath).replace(/\.jsonl$/, "");
}
