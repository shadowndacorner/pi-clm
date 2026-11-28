import { createHash } from "node:crypto";

import { selectProtectedMessageIndexes, shouldAcceptShrink } from "./policy.ts";
import type {
	ApplyDocumentOptions,
	ApplyDocumentResult,
	ContextDocumentSnapshot,
	ContextEditSourceKind,
	ContextEditTrace,
	DocumentBlock,
	LiveContextMessage,
} from "./types.ts";

const DOCUMENT_VERSION = 1;
// Metadata is valid only as the first line. An example copied into a message body must
// never be mistaken for the active document envelope.
const META_RE =
	/^\[\[LIVE_CONTEXT version=(\d+) revision=(\d+) document=([a-f0-9]{64}) baseline=([a-f0-9]{64})\]\](?:\r?\n|$)/;

interface ParsedBlock {
	index: number;
	id: string;
	role: string;
	protected: boolean;
	body: string;
}

interface ParsedDocument {
	version?: number;
	revision?: number;
	documentId?: string;
	baselineDigest?: string;
	blocks: ParsedBlock[];
	preamble: string;
	duplicateIds: string[];
	malformedCurrentHeaders: string[];
	/** Header-shaped lines that are not valid headers of the current document (stale nonce, malformed, foreign). */
	unrecognizedHeaderLines: string[];
	/** Foreign-revision headers that name a block of this document: a stale retype that would silently delete it. */
	foreignHeadersOfLiveBlocks: string[];
}

function normalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalizeJson(item)]),
		);
	}
	return value;
}

export function canonicalMessage(message: LiveContextMessage): string {
	return JSON.stringify(normalizeJson(message));
}

export function digestMessages(messages: LiveContextMessage[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(canonicalMessage(message));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return String(part ?? "");
			const block = part as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") {
				return `[thinking]\n${block.thinking}`;
			}
			if (block.type === "toolCall") {
				const name = typeof block.name === "string" ? block.name : "tool";
				return `[tool call: ${name}]\n${JSON.stringify(normalizeJson(block.arguments ?? {}))}`;
			}
			if (block.type === "image") {
				const mimeType =
					typeof block.mimeType === "string"
						? block.mimeType
						: typeof (block.source as Record<string, unknown> | undefined)?.mediaType === "string"
							? String((block.source as Record<string, unknown>).mediaType)
							: "unknown";
				return `[image: ${mimeType}; data omitted]`;
			}
			return JSON.stringify(normalizeJson(block));
		})
		.filter(Boolean)
		.join("\n");
}

export function renderMessage(message: LiveContextMessage): string {
	const parts: string[] = [];
	let content = textFromContent(message.content);
	const contextRole = (message.details as { contextRole?: unknown } | undefined)?.contextRole;
	if (message.role === "custom" && message.customType === "live-context-projection" && typeof contextRole === "string") {
		const prefix = `[context role=${contextRole}]\n`;
		if (content.startsWith(prefix)) content = content.slice(prefix.length);
	}
	if (content) parts.push(content);

	if (message.role === "bashExecution") {
		if (typeof message.command === "string") parts.push(`[command]\n${message.command}`);
		if (typeof message.output === "string" && message.output) parts.push(`[output]\n${message.output}`);
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		if (typeof message.summary === "string") parts.push(message.summary);
	}

	// Legacy/OpenAI-shaped messages are accepted by the pure core as well.
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (const toolCall of toolCalls) {
		if (!toolCall || typeof toolCall !== "object") continue;
		const fn = (toolCall as Record<string, unknown>).function as Record<string, unknown> | undefined;
		if (!fn) continue;
		parts.push(`[tool call: ${String(fn.name ?? "tool")}]\n${String(fn.arguments ?? "")}`);
	}

	return parts.join("\n\n").trim();
}

export function estimateContextCharacters(messages: LiveContextMessage[]): number {
	return messages.reduce((total, message) => total + renderMessage(message).length, 0);
}

function blockId(message: LiveContextMessage, index: number): string {
	const digest = createHash("sha256").update(canonicalMessage(message)).digest("hex").slice(0, 12);
	return `${index + 1}-${digest}`;
}

function documentId(baselineDigest: string, revision: number): string {
	return createHash("sha256")
		.update(`pi-live-context:${DOCUMENT_VERSION}:${revision}:${baselineDigest}`)
		.digest("hex");
}

/**
 * Structural lines inside a body are escaped when the document nonce is stable across
 * renders (CLM mode). With a per-render nonce this was unnecessary: a header the model
 * printed on one call could never match the nonce of the next render. With a per-revision
 * nonce, a `head -5 LIVE_CONTEXT.md` tool result would contain live headers, so they are
 * neutralised with a leading backslash at render time and restored when a body is edited.
 */
const STRUCTURAL_LINE_RE = /^(\\*)(\[\[(?:CTX_TURN|LIVE_CONTEXT) )/gm;

export function escapeStructuralLines(body: string): string {
	return body.replace(STRUCTURAL_LINE_RE, (_match, slashes: string, start: string) => `\\${slashes}${start}`);
}

export function unescapeStructuralLines(body: string): string {
	return body.replace(STRUCTURAL_LINE_RE, (_match, slashes: string, start: string) =>
		slashes.length > 0 ? `${slashes.slice(1)}${start}` : `${slashes}${start}`,
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RenderContextDocumentOptions {
	revision?: number;
	protectedIndexes?: Set<number>;
	/** CLM-owned capped/withheld bodies: header stays editable=false, but the body is locked. */
	lockedIndexes?: Set<number>;
	/**
	 * When set, the document nonce is derived from this seed and the revision instead of
	 * the rendered baseline, so it stays constant between accepted edits even as new
	 * messages arrive. Header ids a model reads on one call remain valid on the next.
	 * Bodies are then escaped so live headers quoted inside tool output stay inert.
	 */
	documentSeed?: string;
}

export function renderContextDocument(
	messages: LiveContextMessage[],
	options: RenderContextDocumentOptions = {},
): ContextDocumentSnapshot {
	const revision = options.revision ?? 0;
	const protectedIndexes = options.protectedIndexes ?? selectProtectedMessageIndexes(messages);
	const lockedIndexes = options.lockedIndexes ?? new Set<number>();
	const baselineDigest = digestMessages(messages);
	const stable = options.documentSeed !== undefined;
	const currentDocumentId = documentId(stable ? `seed:${options.documentSeed}` : baselineDigest, revision);
	const blocks: DocumentBlock[] = messages.map((source, index) => {
		const id = blockId(source, index);
		const authoredRole = (source.details as { contextRole?: unknown } | undefined)?.contextRole;
		const role = source.role === "custom" && source.customType === "live-context-projection" &&
			typeof authoredRole === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(authoredRole)
			? authoredRole : source.role;
		const protectedBlock = protectedIndexes.has(index);
		const lockedBody = lockedIndexes.has(index);
		return {
			index,
			id,
			role,
			protected: protectedBlock,
			lockedBody,
			header: `[[CTX_TURN document=${currentDocumentId} index=${index + 1} role=${role} id=${id} protected=${protectedBlock}]]`,
			body: stable ? escapeStructuralLines(renderMessage(source)) : renderMessage(source),
			source,
		};
	});
	const renderedBlocks = blocks.map((block) => `${block.header}\n${block.body}`);
	const text = [
		`[[LIVE_CONTEXT version=${DOCUMENT_VERSION} revision=${revision} document=${currentDocumentId} baseline=${baselineDigest}]]`,
		"# Edit bodies or delete editable CTX_TURN blocks. Keep metadata/header lines intact.",
		...renderedBlocks,
	].join("\n\n");

	return {
		version: DOCUMENT_VERSION,
		revision,
		baselineDigest,
		documentId: currentDocumentId,
		stableDocument: stable,
		text,
		messages: [...messages],
		blocks,
	};
}

/** A structurally valid header for some other document (its nonce differs from the current one). */
const FOREIGN_HEADER_RE =
	/^\[\[CTX_TURN document=([0-9a-f]{64}) index=\d+ role=[A-Za-z][A-Za-z0-9_-]* id=([a-zA-Z0-9-]+) protected=(true|false)\]\]$/;

function parseDocument(text: string, snapshot: ContextDocumentSnapshot): ParsedDocument {
	const metadata = META_RE.exec(text);
	const blockRe = new RegExp(
		`^\\[\\[CTX_TURN document=${escapeRegExp(snapshot.documentId)} index=(\\d+) role=([A-Za-z][A-Za-z0-9_-]*) id=([a-zA-Z0-9-]+) protected=(true|false)\\]\\]\\s*$`,
		"gm",
	);
	const matches = [...text.matchAll(blockRe)];
	const blocks: ParsedBlock[] = [];
	const seen = new Set<string>();
	const duplicateIds: string[] = [];

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const start = (match.index ?? 0) + match[0].length;
		const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
		const id = match[3];
		if (seen.has(id)) duplicateIds.push(id);
		seen.add(id);
		blocks.push({
			index: Number(match[1]) - 1,
			role: match[2],
			id,
			protected: match[4] === "true",
			body: text.slice(start, end).trim(),
		});
	}

	const validHeaderLines = new Set(matches.map((match) => match[0].trim()));
	const currentPrefix = `[[CTX_TURN document=${snapshot.documentId} `;
	const malformedCurrentHeaders = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith(currentPrefix) && !validHeaderLines.has(line));
	// Header-shaped lines that the current document does not recognise: an older nonce, a
	// malformed header, or a header for another revision. They make a draft a *stale or
	// broken edit attempt*, never an intentional rewrite of the whole context.
	const unrecognizedHeaderLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("[[CTX_TURN ") && !validHeaderLines.has(line));
	// A rendered-form header from another revision that stands in where a block's own header
	// should be is a re-typed header: the parser cannot frame it, so that block would be
	// silently treated as deleted. The same line inside a body (a captured header list, parser
	// documentation) is ordinary content — the block it names is still framed above it.
	const parsedIds = new Set(blocks.map((block) => block.id));
	const foreignHeadersOfLiveBlocks = text
		.split(/\r?\n/)
		.filter((line) => {
			if (!line.startsWith("[[CTX_TURN document=") || validHeaderLines.has(line.trim())) return false;
			const match = FOREIGN_HEADER_RE.exec(line);
			return match !== null && match[1] !== snapshot.documentId && snapshot.blocks.some((block) => block.id === match[2]) && !parsedIds.has(match[2]);
		});

	const metadataEnd = metadata ? metadata[0].length : 0;
	const firstBlockStart = matches[0]?.index ?? text.length;
	const preamble = text
		.slice(metadataEnd, firstBlockStart)
		.split("\n")
		.filter((line) => !line.trim().startsWith("# Edit bodies or delete editable CTX_TURN blocks."))
		.join("\n")
		.trim();

	return {
		version: metadata ? Number(metadata[1]) : undefined,
		revision: metadata ? Number(metadata[2]) : undefined,
		documentId: metadata?.[3],
		baselineDigest: metadata?.[4],
		blocks,
		preamble,
		duplicateIds,
		malformedCurrentHeaders,
		unrecognizedHeaderLines,
		foreignHeadersOfLiveBlocks,
	};
}

function contentToolCalls(message: LiveContextMessage): Array<{ id?: string; name?: string; arguments?: unknown }> {
	if (!Array.isArray(message.content)) return [];
	return message.content
		.filter(
			(part): part is Record<string, unknown> =>
				Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall"),
		)
		.map((part) => ({
			id: typeof part.id === "string" ? part.id : undefined,
			name: typeof part.name === "string" ? part.name : undefined,
			arguments: part.arguments,
		}));
}

function toolCallIds(message: LiveContextMessage): Set<string> {
	const ids = new Set<string>();
	for (const call of contentToolCalls(message)) if (call.id) ids.add(call.id);
	for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
		if (call && typeof call === "object" && typeof (call as Record<string, unknown>).id === "string") {
			ids.add(String((call as Record<string, unknown>).id));
		}
	}
	return ids;
}

/** Edited body text as it should enter a message: escaped structural lines restored. */
function bodyText(body: string, snapshot: ContextDocumentSnapshot): string {
	return snapshot.stableDocument ? unescapeStructuralLines(body) : body;
}

function contextNote(body: string, source?: LiveContextMessage, requestedRole?: string): LiveContextMessage {
	return {
		role: "custom",
		customType: "live-context-projection",
		content: requestedRole ? `[context role=${requestedRole}]\n${body}` : body,
		...(requestedRole ? { details: { contextRole: requestedRole } } : {}),
		display: false,
		timestamp: typeof source?.timestamp === "number" ? source.timestamp : Date.now(),
	};
}

function changedMessage(source: LiveContextMessage, body: string, requestedRole: string, labelRole = false): LiveContextMessage {
	if (source.role === "assistant" && requestedRole === "assistant") {
		const changed: LiveContextMessage = {
			...source,
			content: [{ type: "text", text: body }],
			stopReason: "stop",
		};
		delete changed.errorMessage;
		delete changed.tool_calls;
		return changed;
	}
	// Only a source-backed result may retain a structured tool identity. Never
	// infer identity from the order of edited blocks or model-authored notes.
	if (source.role === "toolResult" && requestedRole === "toolResult") {
		return { ...source, content: [{ type: "text", text: body }],
			details: { ...(source.details as Record<string, unknown> | undefined), clmEdited: true } };
	}
	if (source.role === "user" && requestedRole === "user") {
		return {
			...source,
			content: Array.isArray(source.content) ? [{ type: "text", text: body }] : body,
		};
	}
	return contextNote(body, source, labelRole ? requestedRole : undefined);
}

interface RepairedGroups {
	messages: LiveContextMessage[];
	/** provenance[i] is the index in the pre-repair candidate array of `messages[i]`. */
	provenance: number[];
}

export function repairToolGroups(messages: LiveContextMessage[]): LiveContextMessage[] {
	return repairToolGroupsWithProvenance(messages, messages.map((_, index) => index)).messages;
}

function repairToolGroupsWithProvenance(messages: LiveContextMessage[], provenance: number[]): RepairedGroups {
	const repaired = [...messages];
	const originOf = [...provenance];
	const dropAt = (index: number, count: number) => {
		repaired.splice(index, count);
		originOf.splice(index, count);
	};

	// §11 limitation 2 fix. A broken tool-call group (the model edited or deleted
	// one side of a call/result pair) is resolved structure-preserving:
	// - source-backed edited results retain their original call identity;
	//   model-authored notes are never promoted into tool results;
	// - a deleted side drops the whole group when the assistant is pure tool calls;
	// - text-bearing assistants keep upstream's demote fallback, which preserves
	//   their prose. Behavior pinned by limitations.test.ts + stable-document tests.
	for (let index = 0; index < repaired.length; index++) {
		const message = repaired[index];
		if (message.role !== "assistant") continue;
		const ids = toolCallIds(message);
		if (ids.size === 0) continue;
		const orderedIds = (Array.isArray(message.content) ? message.content : [])
			.filter((part) => (part as Record<string, unknown>)?.type === "toolCall")
			.map((part) => String((part as Record<string, unknown>).id ?? ""))
			.filter((id) => id.length > 0);

		const resultIds = new Set<string>();
		let duplicateResult = false;
		let cursor = index + 1;
		while (cursor < repaired.length && repaired[cursor].role === "toolResult") {
			const resultId = repaired[cursor].toolCallId;
			if (typeof resultId === "string" && ids.has(resultId)) {
				if (resultIds.has(resultId)) duplicateResult = true;
				resultIds.add(resultId);
			}
			cursor++;
		}
		const missing = orderedIds.filter((id) => !resultIds.has(id));
		const complete = missing.length === 0 && !duplicateResult;
		if (complete) continue;


		const hasText = Array.isArray(message.content)
			&& (message.content as Array<Record<string, unknown>>).some(
				(part: Record<string, unknown>) => part.type === "text" && typeof part.text === "string",
			);
		const assistantOrigin = originOf[index];
		if (!hasText) {
			// A pure tool-call group with a missing side cannot be sent as a valid pair.
			// Replace the whole group with a static CLM-authored tombstone note (no call
			// arguments or result bodies); this keeps the consumed range represented.
			const tombstone: LiveContextMessage = {
				role: "custom",
				customType: "clm:terminal-incomplete",
				content: [{ type: "text", text: "[pi-clm] Terminalized incomplete tool-call group; no provider-valid call/result pair remains." }],
				display: false,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
				details: { toolCallIds: orderedIds, tombstone: true },
			};
			dropAt(index, cursor - index);
			repaired.splice(index, 0, tombstone);
			originOf.splice(index, 0, assistantOrigin);
			index -= 1;
			continue;
		}
		// Keep the assistant's prose, but remove unresolved tool-call fields so the
		// result block is not left orphaned and call arguments are not serialized.
		const proseParts = Array.isArray(message.content)
			? message.content.filter((part) => {
				const type = (part as Record<string, unknown> | undefined)?.type;
				return type !== "toolCall";
			})
			: message.content;
		const prose: LiveContextMessage = {
			...message,
			content: proseParts,
			stopReason: "stop",
		};
		delete (prose as { tool_calls?: unknown }).tool_calls;
		dropAt(index, cursor - index);
		repaired.splice(index, 0, prose);
		originOf.splice(index, 0, assistantOrigin);
		index -= 1;
	}

	for (let index = 0; index < repaired.length; index++) {
		const message = repaired[index];
		if (message.role !== "toolResult") continue;
		let assistantIndex = index - 1;
		while (assistantIndex >= 0 && repaired[assistantIndex].role === "toolResult") assistantIndex--;
		const assistant = assistantIndex >= 0 ? repaired[assistantIndex] : undefined;
		const ids = assistant?.role === "assistant" ? toolCallIds(assistant) : new Set<string>();
		if (typeof message.toolCallId !== "string" || !ids.has(message.toolCallId)) {
			// Orphan result: the assistant side is gone. Do not send its body as an
			// unpaired provider tool result; replace it with static metadata only.
			const tombstone: LiveContextMessage = {
				role: "custom",
				customType: "clm:terminal-orphan-result",
				content: [{ type: "text", text: "[pi-clm] Terminalized orphan tool result; no provider-valid assistant call remains." }],
				display: false,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
				details: {
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					tombstone: true,
				},
			};
			repaired[index] = tombstone;
		}
	}

	// Exactly-once identity: a logical tool call may appear in only one physical result
	// occurrence. Later non-contiguous duplicates become static tombstones, never bodies.
	const seenToolCallIds = new Set<string>();
	for (let index = 0; index < repaired.length; index++) {
		const message = repaired[index];
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		if (seenToolCallIds.has(message.toolCallId)) {
			const tombstone: LiveContextMessage = {
				role: "custom",
				customType: "clm:terminal-duplicate-result",
				content: [{ type: "text", text: "[pi-clm] Terminalized duplicate physical tool result; one logical call has one provider-visible result." }],
				display: false,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
				details: { toolCallId: message.toolCallId, toolName: message.toolName, tombstone: true },
			};
			repaired[index] = tombstone;
			continue;
		}
		seenToolCallIds.add(message.toolCallId);
	}

	return { messages: repaired, provenance: originOf };
}

export function hasOrphanToolMessages(messages: LiveContextMessage[]): boolean {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			const ids = toolCallIds(message);
			if (ids.size === 0) continue;
			const found = new Set<string>();
			let cursor = index + 1;
			while (cursor < messages.length && messages[cursor].role === "toolResult") {
				const resultId = messages[cursor].toolCallId;
				if (typeof resultId === "string" && ids.has(resultId)) found.add(resultId);
				cursor++;
			}
			if ([...ids].some((id) => !found.has(id))) return true;
		}
		if (message.role === "toolResult") {
			let cursor = index - 1;
			while (cursor >= 0 && messages[cursor].role === "toolResult") cursor--;
			const assistant = cursor >= 0 ? messages[cursor] : undefined;
			if (
				!assistant ||
				assistant.role !== "assistant" ||
				typeof message.toolCallId !== "string" ||
				!toolCallIds(assistant).has(message.toolCallId)
			) {
				return true;
			}
		}
	}
	return false;
}

function rejected(
	snapshot: ContextDocumentSnapshot,
	beforeEstimate: number,
	reason: string,
	diagnostics: string[] = [],
): ApplyDocumentResult {
	return {
		accepted: false,
		changed: true,
		messages: [...snapshot.messages],
		beforeEstimate,
		afterEstimate: beforeEstimate,
		savingsEstimate: 0,
		diagnostics,
		reason,
	};
}

export function applyContextDocument(
	editedText: string,
	snapshot: ContextDocumentSnapshot,
	options: ApplyDocumentOptions = {},
): ApplyDocumentResult {
	const estimate = options.estimate ?? estimateContextCharacters;
	const estimateUnit = options.estimateUnit ?? "characters";
	const beforeEstimate = estimate(snapshot.messages);
	if (editedText.trim() === snapshot.text.trim()) {
		return {
			accepted: true,
			changed: false,
			messages: [...snapshot.messages],
			beforeEstimate,
			afterEstimate: beforeEstimate,
			savingsEstimate: 0,
			diagnostics: [],
		};
	}

	const finalize = (
		candidate: LiveContextMessage[],
		candidateOrigins: Array<{ sourceIndex?: number; kind: ContextEditSourceKind | "added" }>,
		removedSourceIndexes: Set<number>,
		diagnostics: string[],
	): ApplyDocumentResult => {
		const repaired = repairToolGroupsWithProvenance(candidate, candidate.map((_, index) => index));
		const messages = repaired.messages;
		if (hasOrphanToolMessages(messages)) {
			return rejected(snapshot, beforeEstimate, "Context edit could not be normalized to legal tool-call structure.", diagnostics);
		}
		const afterEstimate = estimate(messages);
		const requireShrink = options.requireShrink ?? options.editingMode !== "clm";
		if (requireShrink) {
			const shrink = shouldAcceptShrink(beforeEstimate, afterEstimate, options.minSavings ?? 1, estimateUnit);
			if (!shrink.accepted) return rejected(snapshot, beforeEstimate, shrink.reason ?? "Context did not shrink.", diagnostics);
		}

		// Trace the *repaired* projection: outputIndex must address `messages`, so an
		// accepted checkpoint never points at a message that group repair moved or removed.
		const tracedSources: ContextEditTrace["sources"] = messages.flatMap((_, outputIndex) => {
			const candidateIndex = repaired.provenance[outputIndex];
			const origin = candidateOrigins[candidateIndex];
			if (!origin || origin.sourceIndex === undefined) return [];
			const outputMessage = messages[outputIndex];
			if (outputMessage?.role === "custom" && (outputMessage.customType === "clm:terminal-incomplete" || outputMessage.customType === "clm:terminal-orphan-result")) {
				// The original assistant/source is explicitly removed; the tombstone is an addition.
				return [{ sourceIndex: origin.sourceIndex, kind: "removed" as ContextEditSourceKind }];
			}
			const wasNormalized = canonicalMessage(candidate[candidateIndex]) !== canonicalMessage(outputMessage);
			const kind: ContextEditSourceKind = wasNormalized
				? "normalized"
				: origin.kind === "added" ? "edited" : origin.kind;
			return [{ sourceIndex: origin.sourceIndex, outputIndex, kind }];
		});
		// A source the model kept but group repair dropped is gone from the projection: record
		// it as removed rather than leaving it unattributed.
		const surviving = new Set(repaired.provenance);
		for (const [candidateIndex, origin] of candidateOrigins.entries()) {
			if (origin.sourceIndex !== undefined && !surviving.has(candidateIndex)) {
				tracedSources.push({ sourceIndex: origin.sourceIndex, kind: "removed" });
			}
		}
		for (const sourceIndex of removedSourceIndexes) {
			tracedSources.push({ sourceIndex, kind: "removed" });
		}
		tracedSources.sort((left, right) => left.sourceIndex - right.sourceIndex);
		const editTrace: ContextEditTrace = {
			version: 1,
			sourceRevision: snapshot.revision,
			sourceMessageCount: snapshot.messages.length,
			outputMessageCount: messages.length,
			sources: tracedSources,
			additions: repaired.provenance.flatMap((candidateIndex, outputIndex) => {
				const origin = candidateOrigins[candidateIndex];
				const outputMessage = messages[outputIndex];
				if (outputMessage?.role === "custom" && (outputMessage.customType === "clm:terminal-incomplete" || outputMessage.customType === "clm:terminal-orphan-result")) {
					return [{ outputIndex, kind: "added" as const }];
				}
				return origin && origin.sourceIndex === undefined ? [{ outputIndex, kind: "added" as const }] : [];
			}),
		};

		return {
			accepted: true,
			changed: true,
			messages,
			beforeEstimate,
			afterEstimate,
			savingsEstimate: beforeEstimate - afterEstimate,
			diagnostics,
			editTrace,
		};
	};

	const parsed = parseDocument(editedText, snapshot);
	const metadataLine = snapshot.text.split("\n")[0] ?? "";
	// A draft that carries header-shaped lines the current document does not recognise is a
	// stale or broken *edit attempt* (headers re-typed from an earlier read, a nonce that no
	// longer matches, a corrupted header). It must never fall through to the whole-context
	// rewrite below: that path used to accept it as an intentional collapse and delete every
	// block, including the owner's current instruction.
	if (parsed.blocks.length === 0 && parsed.unrecognizedHeaderLines.length > 0) {
		const example = parsed.unrecognizedHeaderLines[0] ?? "";
		return rejected(
			snapshot,
			beforeEstimate,
			`Mirror carries ${parsed.unrecognizedHeaderLines.length} block header(s) from another context revision and no current ones, so it looks like a stale edit rather than a rewrite: ${example.slice(0, 120)}. ` +
				`Re-read the first line of the mirror and its headers, then re-apply the edit against revision ${snapshot.revision}. ` +
				`A header from another revision silently deletes the block it named, so none are accepted. ` +
				`To replace the whole context on purpose, remove every [[CTX_TURN ...]] header line.`,
		);
	}
	// A re-typed header among valid ones must not be allowed to delete its block quietly.
	if (parsed.foreignHeadersOfLiveBlocks.length > 0) {
		return rejected(
			snapshot,
			beforeEstimate,
			`Mirror carries ${parsed.foreignHeadersOfLiveBlocks.length} block header(s) from another context revision that name blocks of this one: ${(parsed.foreignHeadersOfLiveBlocks[0] ?? "").slice(0, 120)}. ` +
				`Such a header does not frame the block, so the block would be dropped — re-read the mirror's headers and re-apply the edit against revision ${snapshot.revision}.`,
		);
	}

	// CLM: a file with no header-shaped lines at all is the model replacing its whole
	// context with free text (the paper's "collapse to a summary" move). Accept it as one
	// notes block, but keep every owner (user) turn: a collapse may summarise everything the
	// model has already seen, never the instructions the owner gave.
	if (options.editingMode === "clm" && parsed.blocks.length === 0 && editedText.trim().length > 0) {
		const body = unescapeStructuralLines(
			editedText
				.split(/\r?\n/)
				.filter((line) => !META_RE.test(`${line}\n`) && !line.trim().startsWith("# Edit bodies or delete editable CTX_TURN blocks."))
				.join("\n")
				.trim(),
		);
		if (body.length === 0) return rejected(snapshot, beforeEstimate, "Mirror is empty after removing metadata; nothing to apply.");
		const candidate: LiveContextMessage[] = [];
		const candidateOrigins: Array<{ sourceIndex?: number; kind: ContextEditSourceKind | "added" }> = [];
		const removedSourceIndexes = new Set<number>();
		let keptUserTurns = 0;
		for (const [index, message] of snapshot.messages.entries()) {
			if (message.role === "user") {
				candidate.push(message);
				candidateOrigins.push({ sourceIndex: index, kind: "kept" });
				keptUserTurns += 1;
			} else {
				removedSourceIndexes.add(index);
			}
		}
		candidate.push(contextNote(body, undefined, "notes"));
		candidateOrigins.push({ kind: "added" });
		return finalize(candidate, candidateOrigins, removedSourceIndexes, [
			"Accepted a full rewrite: every block was replaced by one notes block" +
				(keptUserTurns > 0 ? ` after the ${keptUserTurns} owner turn(s)` : "") +
				". To edit blocks individually, keep the [[CTX_TURN ...]] headers.",
		]);
	}
	// With a stable document the baseline digest still changes every render (new raw
	// messages), so only the revision and nonce identify the document the model edited.
	const baselineMatches = snapshot.stableDocument || parsed.baselineDigest === snapshot.baselineDigest;
	if (
		parsed.version !== snapshot.version ||
		parsed.revision !== snapshot.revision ||
		parsed.documentId !== snapshot.documentId ||
		!baselineMatches
	) {
		return rejected(
			snapshot,
			beforeEstimate,
			`Mirror metadata does not match the current context revision (expected revision ${snapshot.revision}, document ${snapshot.documentId.slice(0, 12)}…). ` +
				`The first line must be exactly: ${metadataLine}`,
		);
	}
	if (parsed.duplicateIds.length > 0) {
		return rejected(snapshot, beforeEstimate, `Mirror contains duplicate block IDs: ${parsed.duplicateIds.join(", ")}.`);
	}
	if (parsed.malformedCurrentHeaders.length > 0) {
		return rejected(snapshot, beforeEstimate, "Mirror contains malformed headers for the current document.");
	}

	const sourceById = new Map(snapshot.blocks.map((block) => [block.id, block]));
	const parsedById = new Map<string, ParsedBlock>();
	const unknownIds: string[] = [];
	for (const block of parsed.blocks) {
		if (!sourceById.has(block.id) && !(options.editingMode === "clm" && /^new-[a-zA-Z0-9-]+$/.test(block.id))) unknownIds.push(block.id);
		else parsedById.set(block.id, block);
	}
	if (unknownIds.length > 0) {
		return rejected(
			snapshot,
			beforeEstimate,
			`Mirror contains unknown block IDs: ${unknownIds.join(", ")}. ` +
				(options.editingMode === "clm"
					? "Use ids from the current mirror headers, or prefix a new block's id with new-."
					: "Use ids from the current mirror headers."),
		);
	}

	const diagnostics: string[] = [];
	const candidate: LiveContextMessage[] = [];
	const candidateOrigins: Array<{ sourceIndex?: number; kind: ContextEditSourceKind | "added" }> = [];
	const removedSourceIndexes = new Set<number>();
	const droppedOwnerTurns: number[] = [];
	// Stray text above the first block keeps its written position as a leading note.
	if (parsed.preamble) {
		candidate.push(contextNote(bodyText(parsed.preamble, snapshot)));
		candidateOrigins.push({ kind: "added" });
	}
	// Conservative mode retains source order. CLM follows the edited order;
	// removed originals are still visited for complete provenance/protected restoration.
	const orderedIds = options.editingMode === "clm"
		? [...parsed.blocks.map((block) => block.id), ...snapshot.blocks.filter((block) => !parsedById.has(block.id)).map((block) => block.id)]
		: snapshot.blocks.map((block) => block.id);
	for (const id of orderedIds) {
		const sourceBlock = sourceById.get(id);
		const parsedBlock = parsedById.get(id);
		if (!sourceBlock) {
			if (parsedBlock?.body) {
				candidate.push(contextNote(bodyText(parsedBlock.body, snapshot), undefined, parsedBlock.role));
				candidateOrigins.push({ kind: "added" });
			}
			continue;
		}
		if (sourceBlock.lockedBody) {
			// Capped/withheld representations are CLM-owned. The model may remove the block,
			// but editing its body would re-cap already-truncated text or hide provenance.
			if (!parsedBlock || !parsedBlock.body) {
				removedSourceIndexes.add(sourceBlock.index);
				continue;
			}
			if (
				parsedBlock.body !== sourceBlock.body ||
				parsedBlock.role !== sourceBlock.role ||
				parsedBlock.protected !== sourceBlock.protected
			) {
				return rejected(
					snapshot,
					beforeEstimate,
					`Block ${sourceBlock.index + 1} is a CLM-owned capped/withheld representation and cannot be edited; remove the block or keep it unchanged.`,
					[],
				);
			}
			candidate.push(sourceBlock.source);
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: "kept" });
			continue;
		}

		if (sourceBlock.protected) {
			const restored =
				!parsedBlock ||
				parsedBlock.body !== sourceBlock.body ||
				parsedBlock.role !== sourceBlock.role ||
				!parsedBlock.protected;
			candidate.push(sourceBlock.source);
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: restored ? "restored" : "kept" });
			if (restored) diagnostics.push(`Restored protected turn ${sourceBlock.index + 1}.`);
			continue;
		}
		if (!parsedBlock || !parsedBlock.body) {
			if (options.editingMode === "clm" && sourceBlock.role === "user") droppedOwnerTurns.push(sourceBlock.index + 1);
			removedSourceIndexes.add(sourceBlock.index);
			continue;
		}
		if (
			parsedBlock.body === sourceBlock.body &&
			parsedBlock.role === sourceBlock.role &&
			parsedBlock.protected === sourceBlock.protected
		) {
			candidate.push(sourceBlock.source);
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: "kept" });
		} else {
			candidate.push(changedMessage(sourceBlock.source, bodyText(parsedBlock.body, snapshot), parsedBlock.role, options.editingMode === "clm"));
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: "edited" });
		}
	}

	// An owner turn is an instruction, not the model's own work: deleting it silently retires
	// a requirement the owner never withdrew. Bodies stay editable; removal is rejected.
	if (droppedOwnerTurns.length > 0) {
		return rejected(
			snapshot,
			beforeEstimate,
			`Owner turns cannot be deleted from the context (turn ${droppedOwnerTurns.join(", ")}). ` +
				`Keep their [[CTX_TURN ...]] headers: rewrite a turn's body to retire it, or move the block to reorder it.`,
			diagnostics,
		);
	}

	return finalize(candidate, candidateOrigins, removedSourceIndexes, diagnostics);
}
