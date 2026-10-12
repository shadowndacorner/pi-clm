import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	applyContextDocument,
	renderContextDocument,
} from "../context-document.ts";
import liveContextExtension from "../index.ts";
import { LIVE_CONTEXT_STATE } from "../state.ts";
import type { LiveContextMessage } from "../types.ts";

// Failing-first tests for the limitations documented in docs/architecture.md §11.
// Each test pins the FIXED behavior; see the limitation id in the test name.

type Handler = (event: any, ctx: any) => any;

type Harness = {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, any>;
	tools: Map<string, any>;
	branch: any[];
	notifications: string[];
	ctx: any;
};

function createHarness(): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const branch: any[] = [];
	const notifications: string[] = [];
	const statuses = new Map<string, string | undefined>();

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
		sendUserMessage() {},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
		sessionManager: {
			getSessionId: () => "limitations-test-session",
			getSessionFile: () => "/tmp/limitations-test-session.jsonl",
			getBranch: () => [...branch],
			getEntries: () => [...branch],
			getEntry: (id: string) => branch.find((entry) => entry.id === id),
			buildContextEntries() {
				return branch.filter((entry) => entry.type === "message").map((entry) => entry);
			},
			getTree: () => [],
			getLeafId: () => null,
		},
		waitForIdle: async () => {},
		isIdle: () => true,
		getContextUsage: () => undefined,
	};

	return { pi, handlers, commands, tools, branch, notifications, ctx };
}

async function emit(harness: Harness, name: string, event: any): Promise<any[]> {
	const results: any[] = [];
	for (const handler of harness.handlers.get(name) ?? []) {
		results.push(await handler(event, harness.ctx));
	}
	return results;
}

const userMsg = (text: string, timestamp: number): LiveContextMessage => ({
	role: "user",
	content: text,
	timestamp,
});

const assistantMsg = (text: string, timestamp: number): LiveContextMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "test",
	provider: "test",
	model: "test",
	usage: { cost: { total: 0 } },
	stopReason: "stop",
	timestamp,
});

const writeToolAssistant = (turnId: string, timestamp: number): LiveContextMessage => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: `considering the compact (${turnId})` },
		{ type: "toolCall", id: `call-${turnId}`, name: "write", arguments: { path: "/mirror/LIVE_CONTEXT.md", content: "…" } },
	],
	api: "test",
	provider: "test",
	model: "test",
	usage: { cost: { total: 0 } },
	stopReason: "toolUse",
	timestamp,
});

const toolResultMsg = (turnId: string, timestamp: number): LiveContextMessage => ({
	role: "toolResult",
	toolCallId: `call-${turnId}`,
	content: [{ type: "text", text: "mirror written" }],
	display: true,
	timestamp,
});

async function startAndGetMirrorPath(harness: Harness): Promise<string> {
	const before = await emit(harness, "before_agent_start", {
		type: "before_agent_start",
		systemPrompt: "base prompt",
		prompt: "task",
		systemPromptOptions: {},
	});
	const systemPrompt = before[0].systemPrompt as string;
	const pathMatch = systemPrompt.match(/mirrored at `([^`]+)`/);
	assert.ok(pathMatch);
	return pathMatch[1]!;
}

async function stateEntry(harness: Harness): Promise<any> {
	return harness.branch.filter((entry) => entry.customType === LIVE_CONTEXT_STATE).at(-1)!;
}

describe("§11 limitation fixes", () => {
	test("limitation 1 (fixed): the accepted edit turn no longer lingers in the next context", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const mirrorPath = await startAndGetMirrorPath(harness);

		const raw = [userMsg("Solve the task", 1), assistantMsg(`Old investigation ${"big\n".repeat(200)}`, 2)];
		await emit(harness, "context", { type: "context", messages: raw });
		const mirror = await readFile(mirrorPath, "utf8");
		const edited = mirror
			.replace(/(\[\[CTX_TURN document=[a-f0-9]{64} index=2 role=assistant[^\n]*\]\]\n)[\s\S]*$/, "$1Investigation complete.");
		await writeFile(mirrorPath, edited, "utf8");

		// The edit turn: a real assistant toolCall + its toolResult.
		const editAssistant = writeToolAssistant("t1", 3);
		const editResult = toolResultMsg("t1", 4);
		await emit(harness, "turn_end", { type: "turn_end", message: editAssistant, toolResults: [editResult] });

		const persisted = await stateEntry(harness);
		assert.equal(persisted.data.lastOutcome.kind, "applied");
		// The anchor consumes the whole edit turn: 2 raw + assistant + result.
		assert.equal(persisted.data.checkpoint.sourceMessageCount, raw.length + 2);

		// Next request: the edit turn stays in the RAW input but must no longer be
		// projected into the effective context.
		const followupUser = userMsg("continue", 5);
		const second = await emit(harness, "context", {
			type: "context",
			messages: [...raw, editAssistant, editResult, followupUser],
		});
		const visible = second[0].messages as LiveContextMessage[];
		const roleOf = (m: LiveContextMessage): string =>
			(m as unknown as { role?: string }).role ?? "";
		assert.ok(visible.some((m) => roleOf(m) === "user" && JSON.stringify(m).includes("continue")));
		assert.ok(!visible.some((m) => JSON.stringify(m).includes("call-t1")), "the mirror-write tool call must be elided");
		assert.ok(!visible.some((m) => JSON.stringify(m).includes("mirror written")), "the edit result must be elided");
		assert.match(JSON.stringify(visible), /Investigation complete/);
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
		await rm(mirrorPath, { force: true }).catch(() => {});
	});

	test("limitation 2 (fixed): deleting one side of a tool pair drops the pair, not the structure", () => {
		const messages: LiveContextMessage[] = [
			userMsg("run the probe", 1),
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "pair-1", name: "bash", arguments: { command: "probe" } },
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: { cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "pair-1",
				content: [{ type: "text", text: "probe output: 9000 lines of data" }],
				display: true,
				timestamp: 3,
			},
		];
		const snapshot = renderContextDocument(messages);
		// The model deleted the toolResult block: its result was compressible noise,
		// but the assistant tool call references it.
		const withoutResult = snapshot.text.split("\n").filter((line) => !/9000 lines/.test(line)).join("\n");
		const result = applyContextDocument(withoutResult, snapshot, {
			editingMode: "clm",
			estimate: (ms) => 100 * 1, // conservative: growth allowed in clm mode
		});
		assert.ok(result.accepted, `edit should be valid; reason: ${result.reason}`);
		// The pair must be GONE — not demoted into text notes that carry the call.
		assert.ok(!JSON.stringify(result.messages).includes("[tool call: bash]"),
			"assistant must not be demoted to a text note retaining the tool call");
		assert.ok(!JSON.stringify(result.messages).includes("9000 lines"),
			"the deleted result must not linger as a text note");
	});

	test("limitation 3 (fixed): outcome notices persist for a bounded number of requests", async () => {
		const harness = createHarness();
		liveContextExtension(harness.pi);
		await emit(harness, "session_start", { type: "session_start", reason: "startup" });
		const mirrorPath = await startAndGetMirrorPath(harness);

		const raw = [userMsg("Solve the task", 1), assistantMsg("Progress so far\n".repeat(50), 2)];
		await emit(harness, "context", { type: "context", messages: raw });
		const mirror = await readFile(mirrorPath, "utf8");
		// Growth edit: rejected in the default conservative mode.
		const grow = mirror + "\n Museum-grade filler that certainly did not shrink the document.\n";
		await writeFile(mirrorPath, grow, "utf8");
		await emit(harness, "turn_end", { type: "turn_end", message: {}, toolResults: [] });
		const persisted = await stateEntry(harness);
		assert.equal(persisted.data.lastOutcome.kind, "rejected");

		const noticeText = async (): Promise<string> => {
			const out = await emit(harness, "context", { type: "context", messages: raw });
			const last = (out[0].messages as LiveContextMessage[]).at(-1);
			return (last as unknown as { content?: string })?.content ?? "";
			void assert;
		};
		const first = await noticeText();
		assert.match(first, /Edit rejected/);
		const second = await noticeText();
		assert.match(second, /Edit rejected/);
		const third = await noticeText();
		assert.ok(!/Edit rejected/.test(third)); // bounded: gone by the third repeat
		await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
		await rm(mirrorPath, { force: true }).catch(() => {});
	});

	test("limitation 5 (fixed): PI_CLM_MIRROR_DIR relocates the mirror for container-visible storage", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const customParent = await mkdtemp(join(tmpdir(), "clm-mirror-loc-"));
		process.env.PI_CLM_MIRROR_DIR = customParent;
		try {
			const harness = createHarness();
			liveContextExtension(harness.pi);
			await emit(harness, "session_start", { type: "session_start", reason: "startup" });
			const mirrorPath = await startAndGetMirrorPath(harness);
			assert.ok(
				mirrorPath.startsWith(customParent),
				`mirror must live under PI_CLM_MIRROR_DIR (${customParent}), got ${mirrorPath}`,
			);
			await emit(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
			await rm(mirrorPath, { force: true }).catch(() => {});
		} finally {
			Reflect.deleteProperty(process.env, "PI_CLM_MIRROR_DIR");
			await rm(customParent, { recursive: true, force: true }).catch(() => {});
		}
	});
});
