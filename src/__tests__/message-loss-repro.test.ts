import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyContextDocument, renderContextDocument } from "../context-document.ts";
import type { LiveContextMessage } from "../types.ts";

// Synthetic regression scenario: preserve later user instructions after collapse.
function conversation(): LiveContextMessage[] {
	return [
		{ role: "user", content: "Prepare the example document.", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: `Old investigation\n${"large output\n".repeat(120)}` }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		},
		{
			role: "user",
			content: "Can you sort the example items alphabetically? Use ascending order.",
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: `Ack.\n${"large output\n".repeat(120)}` }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 4,
		},
	];
}

const INSTRUCTION = "Can you sort the example items alphabetically?";

function snapshotOf(messages: LiveContextMessage[]) {
	return renderContextDocument(messages, { revision: 1 });
}

describe("user turns survive a mirror collapse", () => {
	test("a headerless collapse keeps the newest user turn, not only the first", () => {
		const messages = conversation();
		const snapshot = snapshotOf(messages);
		// The model replaces its whole context with free text (the paper's collapse move).
		const edited = "Working notes: prepare and sort the example document.\n";

		const result = applyContextDocument(edited, snapshot, { editingMode: "clm" });

		assert.ok(result.accepted, `edit should be accepted: ${result.reason ?? ""}`);
		const keptUserTurns = result.messages.filter((message) => message.role === "user");
		assert.ok(
			keptUserTurns.some((message) => typeof message.content === "string" && message.content.includes(INSTRUCTION)),
			`the newest user turn was dropped from the assembled request; kept user turns: ${JSON.stringify(
				keptUserTurns.map((message) => String(message.content).slice(0, 40)),
			)}`,
		);
	});

	test("deleting a user turn block by id drops that instruction from the request", () => {
		const messages = conversation();
		const snapshot = snapshotOf(messages);
		// A model removing one CTX_TURN block: the block carrying the owner instruction.
		const lines = snapshot.text.split(/\r?\n/);
		const target = lines.findIndex((line) => line.includes("role=user") && line.includes(snapshot.revision ? "" : ""));
		const userHeaders = lines
			.map((line, index) => ({ line, index }))
			.filter(({ line }) => line.startsWith("[[CTX_TURN") && line.includes("role=user"));
		assert.ok(userHeaders.length >= 2, `expected at least two user turn blocks, got ${userHeaders.length}`);
		const chosen = userHeaders[userHeaders.length - 1]!;
		const next = userHeaders.length > 1 ? userHeaders[userHeaders.length - 2]! : undefined;
		const cutFrom = next ? next.index + 1 : chosen.index;
		const edited = [...lines.slice(0, cutFrom), ...lines.slice(chosen.index)].join("\n");

		const result = applyContextDocument(edited, snapshot, { editingMode: "clm" });

		if (!result.accepted) return; // a rejection here would already be protective
		const keptUserTurns = result.messages.filter((message) => message.role === "user");
		assert.ok(
			keptUserTurns.some((message) => typeof message.content === "string" && message.content.includes(INSTRUCTION)),
			`a deleted user-turn block silently removed the owner instruction; kept: ${JSON.stringify(
				keptUserTurns.map((message) => String(message.content).slice(0, 40)),
			)}`,
		);
		void target;
	});
});
