import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import liveContextExtension from "../index.ts";
import { LIVE_CONTEXT_STATE } from "../state.ts";
import type { ProjectionCheckpoint } from "../projection.ts";
import type { LiveContextMessage } from "../types.ts";

/** Regression coverage for context_edit entries during Pi session projection. */

type Handler = (event: any, context: any) => any;

function user(id: string, text: string, timestamp: number): any {
	return {
		type: "message",
		id,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	};
}

function assistant(id: string, text: string, timestamp: number): any {
	return {
		type: "message",
		id,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { cost: { total: 0 } },
			stopReason: "stop",
			timestamp,
		},
	};
}

function conversation(): any[] {
	const entries: any[] = [];
	let parentId: string | null = null;
	const push = (entry: any) => {
		entry.parentId = parentId;
		parentId = entry.id;
		entries.push(entry);
	};
	push(user("entry-1", "Investigate the parser.", 1));
	push(assistant("entry-2", `First pass\n${"large investigation output\n".repeat(120)}`, 2));
	push(user("entry-3", "Anything else?", 3));
	push(assistant("entry-4", "No, the parser is the only relevant file.", 4));
	push(user("entry-5", "Now test another parser input.", 5));
	push(assistant("entry-6", "Testing the additional parser input.", 6));
	return entries;
}

type Harness = {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	branch: any[];
	notifications: Array<{ message: string; level?: string }>;
	statuses: Map<string, string | undefined>;
	ctx: any;
	undoEntry(targetId: string): void;
	assembledMessages(): LiveContextMessage[];
};

function createHarness(initialBranch: any[] = []): Harness {
	const handlers = new Map<string, Handler[]>();
	const branch = [...initialBranch];
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses = new Map<string, string | undefined>();

	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
		registerTool() {},
		appendEntry(customType: string, data: unknown) {
			branch.push({
				type: "custom",
				id: `custom-${branch.length + 1}`,
				parentId: branch.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			});
		},
	} as unknown as ExtensionAPI;

	/** Faithful to pi 1.3.0 buildSessionProjection(): context_edit entries are entries. */
	const projection = () => {
		const edits = new Map<string, unknown>();
		for (const entry of branch) {
			if (entry.type !== "context_edit") continue;
			edits.set(entry.targetId, entry.replacement === null ? null : entry.replacement);
		}
		const entries: Array<{ sourceEntry: { id: string }; messages: LiveContextMessage[] }> = [];
		for (const entry of branch) {
			if (entry.type === "session") continue;
			let messages: LiveContextMessage[] = [];
			if (entry.type === "message") messages = [entry.message as LiveContextMessage];
			// A context_edit contributes no messages of its own but stays on the branch,
			// and zeroes (or rewrites) the messages of the entry it targets.
			if (entry.type === "custom_message") {
				messages = [
					{ role: "custom", customType: entry.customType, content: entry.content ?? [], timestamp: 0 } as LiveContextMessage,
				];
			}
			const edit = edits.get(entry.id);
			if (edit === null) messages = [];
			else if (edit !== undefined && entry.type === "message") {
				messages = [{ ...(entry.message as LiveContextMessage), ...(edit as any) }];
			}
			entries.push({ sourceEntry: { id: entry.id }, messages });
		}
		return { entries, messages: entries.flatMap((entry) => entry.messages) };
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			getSessionId: () => "tree-undo-journal-session",
			getSessionFile: () => "/tmp/tree-undo-journal-session.jsonl",
			getBranch: () => [...branch],
			getEntries: () => [...branch],
			getEntry: (id: string) => branch.find((entry) => entry.id === id),
			buildContextEntries: () => [],
			buildSessionProjection: () => projection(),
			getTree: () => [],
			getLeafId: () => branch.at(-1)?.id ?? null,
		},
		waitForIdle: async () => {},
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000, percent: 0.6 }),
		getSystemPrompt: () => "base prompt",
		model: { contextWindow: 100_000, maxTokens: 4096 },
	};

	return {
		pi,
		handlers,
		branch,
		notifications,
		statuses,
		ctx,
		undoEntry(targetId: string) {
			branch.push({
				type: "context_edit",
				id: `edit-${branch.length + 1}`,
				parentId: branch.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				targetId,
				replacement: null,
			});
		},
		assembledMessages: () => projection().messages,
	};
}

async function emit(harness: Harness, name: string, event: any): Promise<any[]> {
	const results: any[] = [];
	for (const handler of harness.handlers.get(name) ?? []) results.push(await handler(event, harness.ctx));
	return results;
}

function latestState(harness: Harness): any {
	return harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1)?.data;
}

/** Accept a mirror edit that compacts the verbose assistant turn inside the prefix. */
async function acceptCompactionEdit(harness: Harness): Promise<string> {
	const before = await emit(harness, "before_agent_start", {
		type: "before_agent_start",
		systemPrompt: "base prompt",
		prompt: "task",
		systemPromptOptions: {},
	});
	const mirrorPath = String(before[0].systemPrompt).match(/mirrored at `([^`]+)`/)![1];
	const mirror = await readFile(mirrorPath, "utf8");
	const edited = mirror.replace(
		/(\[\[CTX_TURN document=[a-f0-9]{64} index=2 role=assistant[^\n]*\]\]\n)[\s\S]*?(?=\n\[\[CTX_TURN|\n$|$)/,
		"$1Parser confirmed: only parser.ts matters.",
	);
	assert.notEqual(edited, mirror, "the mirror must contain the verbose assistant turn");
	await writeFile(mirrorPath, edited, "utf8");
	await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
	return mirrorPath;
}

async function buildCompactedBranch(options: { stripEntryIdentity?: boolean } = {}) {
	const harness = createHarness(conversation());
	liveContextExtension(harness.pi);
	await emit(harness, "session_start", { type: "session_start", reason: "startup" });
	await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
	const mirrorPath = await acceptCompactionEdit(harness);

	const checkpoint: ProjectionCheckpoint = latestState(harness).checkpoint!;
	assert.ok(checkpoint, "the mirror edit must leave an active checkpoint");
	const applied = await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
	assert.doesNotMatch(
		JSON.stringify(applied[0]?.messages),
		/large investigation output/,
		"the compaction must be applied before the undo",
	);
	await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });

	if (options.stripEntryIdentity) {
		// Legacy checkpoints carry sourceMessageCount and digest without entry identity.
		for (const entry of harness.branch) {
			if (entry.customType !== LIVE_CONTEXT_STATE) continue;
			if (entry.data?.checkpoint) delete entry.data.checkpoint.sourceEntries;
		}
	}
	return { branch: harness.branch, mirrorPath };
}

describe("/tree undo against pi's real session projection", () => {
	test("undo of an already-compacted message keeps the compaction applied", async () => {
		const { branch } = await buildCompactedBranch();
		const harness = createHarness(branch);
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "resume" });

		// `/tree` undo of entry-2, an entry that sits inside the compacted range. pi appends a
		// context_edit entry to the branch; it contributes no messages but does occupy a slot.
		harness.undoEntry("entry-2");
		const result = await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		const sent = result[0]?.messages as LiveContextMessage[] | undefined;
		const sentJson = JSON.stringify(sent ?? harness.assembledMessages());

		assert.doesNotMatch(sentJson, /large investigation output/, "the compaction must survive the undo");
		assert.match(sentJson, /Parser confirmed: only parser\.ts matters\./);
		assert.doesNotMatch(sentJson, /First pass/, "the undone message must not be sent");
		assert.equal(
			latestState(harness).lastOutcome?.kind,
			"applied",
			`an undo must not reset the projection: ${JSON.stringify(latestState(harness).lastOutcome)}`,
		);
		assert.ok(latestState(harness).checkpoint, "an active checkpoint must remain after the undo");
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("two successive undos of compacted entries still do not discard the compaction", async () => {
		const { branch } = await buildCompactedBranch();
		const harness = createHarness(branch);
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "resume" });
		harness.undoEntry("entry-2");
		harness.undoEntry("entry-3");
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		harness.undoEntry("entry-4");
		const result = await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		const sentJson = JSON.stringify(result[0]?.messages ?? harness.assembledMessages());
		assert.doesNotMatch(sentJson, /large investigation output/);
		assert.equal(latestState(harness).lastOutcome?.kind, "applied");
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("a checkpoint without entry identity is not discarded by an undo, and no oversized raw send happens", async () => {
		const { branch } = await buildCompactedBranch({ stripEntryIdentity: true });
		const harness = createHarness(branch);
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "resume" });

		// Undo a short entry that sits inside the compacted range. The verbose entry-2 stays on
		// the branch, so it is only kept out of the request while the compaction is applied.
		harness.undoEntry("entry-3");
		const raw = harness.assembledMessages();
		const result = await emit(harness, "context", { type: "context", messages: raw });
		const sent = result[0]?.messages as LiveContextMessage[] | undefined;
		const sentJson = JSON.stringify(sent ?? raw);

		// An identity-less checkpoint must not fall back to sending the raw transcript.
		assert.doesNotMatch(
			sentJson,
			/large investigation output/,
			"an identity-less checkpoint must not fall back to sending the raw transcript",
		);
		assert.notEqual(
			latestState(harness).lastOutcome?.kind,
			"reset",
			`an undo must not discard the compaction: ${JSON.stringify(latestState(harness).lastOutcome)}`,
		);
		assert.ok(latestState(harness).checkpoint, "an active checkpoint must survive an identity-less resume");
		const footer = harness.statuses.get("live-context") ?? "";
		assert.doesNotMatch(footer, /398|39[0-9]\.[0-9]%/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
