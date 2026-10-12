import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * pi session JSONL → cost, turns and a step-indexed digest with per-request
 * context composition.
 *
 * pi's session format is append-only JSONL; each line is an entry (`type`:
 * session, message, custom, …; messages carry roles user / assistant /
 * toolResult; assistant content blocks are text / thinking / toolCall).
 * Assistant entries carry provider `usage` (tokens and, when the provider
 * reports it, cost). The digest is the trajectory the proposer reads: one line
 * per step (user message, assistant message with its tool calls, tool result).
 *
 * The note asks for levers derived from *measured per-turn context
 * composition*, not from skill prose — so every assistant (request) step maps a
 * composition segment: the request's input size, the delta vs the prior
 * request, and the share of newly-added bytes that came from tool results.
 * Those segments land in `composition` and in the step lines themselves.
 */

export interface RequestComposition {
	/** Provider-reported input tokens for this request. */
	inputTokens: number;
	/** inputTokens minus the prior request's input (null for the first). */
	deltaTokens: number | null;
	/** Share of bytes added since the prior request that are tool results (%). */
	toolResultSharePct: number | null;
}

export interface SessionFacts {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** Provider-reported USD over the session; null when not reported. */
	usd: number | null;
	steps: string[];
	/** One entry per assistant (request) step, in order. */
	composition: RequestComposition[];
	/** Number of custom live-context entries (mirrors/projections) recorded. */
	contextEdits: number;
}

interface EntryLine {
	type?: string;
	customType?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
	};
}

function blocksOf(message: EntryLine["message"]): Array<Record<string, unknown>> {
	return Array.isArray(message?.content) ? message!.content as Array<Record<string, unknown>> : [];
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (c && typeof c === "object") {
			if (c["type"] === "text") parts.push(String(c["text"] ?? ""));
			else if (c["type"] === "thinking") parts.push(`(thinking ${String(c["thinking"] ?? "").length} ch)`);
		}
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

function toolCallsOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const calls: string[] = [];
	for (const c of content) {
		if (!c || typeof c !== "object" || c["type"] !== "toolCall") continue;
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

function firstText(content: unknown): string {
	if (!Array.isArray(content)) return "(no text)";
	for (const c of content) {
		if (c && typeof c === "object" && c["type"] === "text") {
			return clip(String(c["text"] ?? "").replace(/\s+/g, " ").trim(), 300);
		}
	}
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
		composition: [],
		contextEdits: 0,
	};
	let usdSeen = false;
	let usdSum = 0;
	let step = 0;
	// Composition accumulators: reset at each assistant (request) step.
	let prevInput: number | null = null;
	let toolChars = 0;
	let allChars = 0;
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
		const content = msg.content;
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
			const text = textOf(content);
			if (!text) continue;
			allChars += text.length;
			step += 1;
			facts.steps.push(`step ${step} | user | ${clip(text, 300)} | ~in ${usage?.input ?? 0} tok`);
		} else if (role === "assistant") {
			step += 1;
			const inputTokens = Number(usage?.input ?? 0);
			const deltaTokens = inputTokens > 0 && prevInput !== null ? inputTokens - prevInput : null;
			const toolResultSharePct = allChars > 0 ? Math.round((100 * toolChars) / allChars) : null;
			facts.composition.push({ inputTokens, deltaTokens, toolResultSharePct });
			const tools = toolCallsOf(content);
			const comp = deltaTokens === null
				? `ctx ~${inputTokens} tok (first request; tool-result ${toolResultSharePct ?? 0}% of new bytes)`
				: `ctx ~${inputTokens} tok (Δ${deltaTokens >= 0 ? "+" : ""}${deltaTokens} vs prior; tool-result ${toolResultSharePct ?? 0}% of new bytes)`;
			const parts = [`step ${step} | assistant`];
			if (tools) parts.push(`tools: ${clip(tools, 200)}`);
			parts.push(clip(textOf(content), 400));
			parts.push(`(${usage ? `in ${usage.input ?? 0} / out ${usage.output ?? 0}` : "usage missing"})`);
			parts.push(comp);
			facts.steps.push(parts.join(" | "));
			facts.turns += 1;
			prevInput = inputTokens > 0 ? inputTokens : prevInput;
			toolChars = 0;
			allChars = 0;
		} else if (role === "toolResult") {
			const body = firstText(content);
			const size = Array.isArray(content)
				? content.reduce((sum, part) => sum + String((part as Record<string, unknown>)?.text ?? "").length, 0)
				: 0;
			toolChars += size;
			allChars += size;
			step += 1;
			facts.steps.push(`step ${step} | toolResult | ${body}`);
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
