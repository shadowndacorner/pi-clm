import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import liveContextExtension from "../index.ts";
import { LIVE_CONTEXT_STATE } from "../state.ts";
import type { ProjectionCheckpoint } from "../projection.ts";
import type { LiveContextMessage } from "../types.ts";

/**
 * Reproduces the /tree undo wreck.
 *
 * Pi's tree navigation records a `context_edit` entry whose `replacement` is null, and
 * `buildSessionProjection()` then drops the targeted message from the assembled context.
 * CLM anchored its compaction checkpoint to a digest of a *positional raw prefix*, so a
 * deletion inside that prefix invalidated the checkpoint, and the handler responded by
 * persisting a reset (revision++, checkpoint dropped). Every later request therefore sent
 * the whole raw transcript: the provider answered 400 "request exceeds the context
 * window" while CLM's own meter still quoted the projection it no longer applied.
 */

type Handler = (event: any, ctx: any) => any;

type Harness = {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, any>;
	tools: Map<string, any>;
	branch: any[];
	notifications: Array<{ message: string; level?: string }>;
	statuses: Map<string, string | undefined>;
	ctx: any;
	/** Simulate pi's `/tree` undo: append a null context_edit for `targetId`. */
	undoEntry(targetId: string): void;
	/** The raw messages pi would hand to the `context` hook after tree navigation. */
	assembledMessages(): LiveContextMessage[];
	projection(): { entries: Array<{ sourceEntry: { id: string }; messages: LiveContextMessage[] }> };
};

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

/** Session entries for a conversation long enough for the mirror edit to shrink it. */
function conversation(): any[] {
	const entries: any[] = [];
	let parentId: string | null = null;
	const push = (entry: any) => {
		entry.parentId = parentId;
		parentId = entry.id;
		entries.push(entry);
	};
	push(user("entry-1", "Investigate the parser.", 1));
	push(
		assistant(
			"entry-2",
			`First pass\n${"large investigation output\n".repeat(120)}`,
			2,
		),
	);
	push(user("entry-3", "Anything else?", 3));
	push(assistant("entry-4", "No, the parser is the only relevant file.", 4));
	return entries;
}

function createHarness(initialBranch: any[] = []): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const branch = [...initialBranch];
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const edits = new Map<string, unknown>();

	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
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

	const projection = () => {
		const entries: Array<{ sourceEntry: { id: string }; messages: LiveContextMessage[] }> = [];
		// Pi resolves context_edit entries against the whole branch, not walk order: an undo
		// recorded later in the file still removes an earlier message from the context.
		for (const entry of branch) {
			if (entry.type !== "context_edit") continue;
			edits.set(entry.targetId, entry.replacement === null ? null : entry.replacement ?? undefined);
		}
		for (const entry of branch) {
			if (entry.type === "session" || entry.type === "context_edit") continue;
			let messages: LiveContextMessage[] = [];
			if (entry.type === "message") messages = [entry.message as LiveContextMessage];
			if (entry.type === "custom_message") {
				messages = [{ role: "custom", customType: entry.customType, content: entry.content ?? [], timestamp: 0 } as LiveContextMessage];
			}
			const edit = edits.get(entry.id);
			if (edit === null) messages = [];
			else if (edit !== undefined && entry.type === "message") {
				messages = [{ ...(entry.message as LiveContextMessage), ...(edit as LiveContextMessage) }];
			}
			entries.push({ sourceEntry: { id: entry.id }, messages });
		}
		return { entries };
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
			getSessionId: () => "tree-undo-session",
			getSessionFile: () => "/tmp/tree-undo-session.jsonl",
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
		commands,
		tools,
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
		assembledMessages() {
			return projection().entries.flatMap((entry) => entry.messages);
		},
		projection,
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

/** Accept a mirror edit that compacts the second (verbose) assistant turn. */
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
	assert.notEqual(edited, mirror);
	await writeFile(mirrorPath, edited, "utf8");
	await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
	return mirrorPath;
}

describe("tree undo keeps CLM compaction coupled to the sent history", () => {
	test("checkpoint records the session entry ids it covers", async () => {
		const harness = createHarness(conversation());
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		await acceptCompactionEdit(harness);

		const checkpoint: ProjectionCheckpoint = latestState(harness).checkpoint!;
		assert.ok(checkpoint, "the edit must leave an active checkpoint");
		assert.deepEqual(
			checkpoint.sourceEntries!.map((entry: { id: string }) => entry.id),
			["entry-1", "entry-2", "entry-3", "entry-4"],
		);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("/tree undo of a covered message keeps the compaction applied and drops that message", async () => {
		const harness = createHarness(conversation());
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		await acceptCompactionEdit(harness);
		const checkpoint: ProjectionCheckpoint = latestState(harness).checkpoint!;
		assert.ok(checkpoint);

		// Pi's /tree undo: the last assistant turn is nulled out of the assembled context.
		harness.undoEntry("entry-4");
		const result = await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		const sent = result[0].messages as LiveContextMessage[];

		// (a) the undone message stays out of the sent context.
		assert.doesNotMatch(JSON.stringify(sent), /the parser is the only relevant file/);
		// (b) the compaction survives: the verbose first turn is still compacted.
		assert.doesNotMatch(JSON.stringify(sent), /large investigation output/);
		assert.match(JSON.stringify(sent), /Parser confirmed: only parser\.ts matters\./);
		// The reset that made the wreck permanent must not be persisted.
		assert.notEqual(latestState(harness).lastOutcome?.kind, "reset");
		assert.ok(latestState(harness).checkpoint, "an active checkpoint must remain");
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("undo on a branched branch replays from the nearest surviving checkpoint without a raw send", async () => {
		const harness = createHarness(conversation());
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		await acceptCompactionEdit(harness);

		// Undo to before the last user turn, then continue on a new branch.
		harness.undoEntry("entry-3");
		harness.branch.push({ ...user("entry-5", "New question after the undo.", 5), parentId: "entry-2" });
		harness.branch.push({ ...assistant("entry-6", "Answer on the new branch.", 6), parentId: "entry-5" });

		const result = await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		const sent = JSON.stringify(result[0].messages as LiveContextMessage[]);
		assert.doesNotMatch(sent, /large investigation output/, "compaction must still be applied");
		assert.match(sent, /New question after the undo\./);
		assert.match(sent, /Answer on the new branch\./);
		assert.equal(latestState(harness).lastOutcome?.kind !== "reset", true);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("an unrecoverable projection surfaces an error instead of silently sending the raw transcript", async () => {
		const harness = createHarness(conversation());
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		await acceptCompactionEdit(harness);

		// Covered content edited in place (pi's non-null context_edit replacement): the
		// projection can no longer be replayed, and the raw prefix no longer matches.
		harness.branch.push({
			type: "context_edit",
			id: "edit-replaced",
			parentId: harness.branch.at(-1)!.id,
			timestamp: new Date().toISOString(),
			targetId: "entry-2",
			replacement: { content: [{ type: "text", text: "externally rewritten" }] },
		});

		const before = JSON.stringify(harness.assembledMessages());
		const result = await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		const sent = result[0]?.messages as LiveContextMessage[] | undefined;

		// The user is told, at the moment it happens, that compaction could not be replayed.
		assert.ok(
			harness.notifications.some((n) => /could not be re-anchored|cannot be re-anchored/i.test(n.message)),
			"re-anchor failure must be surfaced to the user",
		);
		// And the request must not silently become the full raw transcript.
		if (sent) assert.notEqual(JSON.stringify(sent.filter((m) => (m as any).customType !== "live-context-notice")), before);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});

	test("a projection reset clears the stale budget reading the meter would otherwise reuse", async () => {
		const harness = createHarness(conversation());
		liveContextExtension(harness.pi, { editingMode: "clm", budget: { contextBudget: 60_000, reserve: 8_000, remindAtFractions: [0.5] } });
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		await acceptCompactionEdit(harness);
		await emit(harness, "context", { type: "context", messages: harness.assembledMessages() });
		const footerAfterEdit = harness.statuses.get("live-context") ?? "";
		assert.match(footerAfterEdit, /clm/);
		const quotedTokens = footerAfterEdit.match(/clm\s+([\d.]+k?)\s*\//)?.[1];
		assert.ok(quotedTokens, "the meter quotes the projected request while a checkpoint is active");

		// Force an unrecoverable invalidation (no entry identity available), then check the
		// footer no longer quotes the size of a projection that is no longer applied.
		const broken = harness.assembledMessages();
		broken[1] = { ...broken[1], content: "externally rewritten raw history" };
		harness.ctx.sessionManager.buildSessionProjection = () => {
			throw new Error("unavailable");
		};
		await emit(harness, "context", { type: "context", messages: broken });
		assert.equal(latestState(harness).checkpoint, undefined, "the inconsistent projection is discarded");
		const footer = harness.statuses.get("live-context") ?? "";
		assert.doesNotMatch(
			footer,
			new RegExp(`clm\s+${quotedTokens!.replace(".", "\\.")}k?\s*/`),
			`meter must not report the dropped projection: ${footer}`,
		);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
});
