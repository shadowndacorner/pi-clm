import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyContextDocument, canonicalMessage, renderContextDocument } from "../context-document.ts";
import type { ContextDocumentSnapshot, LiveContextMessage } from "../types.ts";

const clm = { editingMode: "clm" as const };

function conversation(): LiveContextMessage[] {
	return [
		{ role: "user", content: "task", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], timestamp: 2 } as LiveContextMessage,
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "one" }],
			isError: false,
			timestamp: 3,
		} as LiveContextMessage,
		{ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: {} }], timestamp: 4 } as LiveContextMessage,
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "bash",
			content: [{ type: "text", text: "two" }],
			isError: false,
			timestamp: 5,
		} as LiveContextMessage,
		{ role: "assistant", content: [{ type: "text", text: "the conclusion is 7" }], timestamp: 6 } as LiveContextMessage,
		{ role: "user", content: "next step", timestamp: 7 },
	];
}

function snapshotOf(messages: LiveContextMessage[]): ContextDocumentSnapshot {
	return renderContextDocument(messages, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
}

/** Drop one whole block (header + body) by its rendered block id. */
function dropBlockById(snapshot: ContextDocumentSnapshot, id: string): string {
	const lines = snapshot.text.split(/\r?\n/);
	const header = lines.findIndex((line) => /^\[\[CTX_TURN /.test(line) && line.includes(`id=${id} `));
	assert.notEqual(header, -1, `fixture could not find a block with id ${id}`);
	const next = lines.findIndex((line, index) => index > header && /^\[\[CTX_TURN /.test(line));
	const editedLines = [...lines.slice(0, header), ...lines.slice(next === -1 ? lines.length : next)];
	assert.ok(!editedLines.some((line) => line.startsWith("[[CTX_TURN ") && line.includes(`id=${id} `)), "the fixture must remove the block header");
	return editedLines.join("\n");
}

function blockId(snapshot: ContextDocumentSnapshot, index: number): string {
	const block = snapshot.blocks.find((candidate) => candidate.index === index);
	assert.ok(block, `fixture has no block at index ${index}`);
	return block!.id;
}

/** Every retained trace entry must point at the message it claims to describe. */
function assertTraceAlignsWithOutput(
	result: { messages: LiveContextMessage[]; editTrace?: { sources: Array<{ sourceIndex?: number; outputIndex?: number; kind: string }>; outputMessageCount: number } },
	snapshot: ContextDocumentSnapshot,
) {
	const trace = result.editTrace;
	assert.ok(trace, "an accepted edit must carry an edit trace");
	for (const source of trace.sources) {
		if (source.kind === "removed" || source.sourceIndex === undefined || source.outputIndex === undefined) continue;
		const claimed = result.messages[source.outputIndex];
		assert.notEqual(claimed, undefined, `trace outputIndex ${source.outputIndex} is outside the projection (${result.messages.length} messages)`);
		const expected = snapshot.messages[source.sourceIndex];
		assert.notEqual(expected, undefined, `trace sourceIndex ${source.sourceIndex} is outside the source document`);
		assert.equal(
			canonicalMessage(claimed),
			canonicalMessage(expected),
			`trace entry (${source.sourceIndex} -> ${source.outputIndex}) describes the wrong message`,
		);
	}
}

describe("edit trace alignment after tool-group repair", () => {
	test("a dropped tool-call group does not shift trace output indexes", () => {
		const snapshot = snapshotOf(conversation());
		// The model deletes one side of the first tool group; repair drops the whole group,
		// so every later message moves two positions earlier in the projection.
		const edited = dropBlockById(snapshot, blockId(snapshot, 2));
		const result = applyContextDocument(edited, snapshot, clm);

		assert.equal(result.accepted, true, result.reason);
		assert.equal(result.messages.length, 6, "the terminalized group remains one tombstone in the projection");
		assert.equal(result.messages.some((message) => message.customType === "clm:terminal-incomplete"), true);
		assertTraceAlignsWithOutput(result, snapshot);
	});

	test("an added notes block is traced to the projection that will be sent", () => {
		const snapshot = snapshotOf(conversation());
		// Drop one side of the first group (repair removes the whole group) and add a note.
		const dropped = dropBlockById(snapshot, blockId(snapshot, 2));
		const edited = `${dropped}\n\n[[CTX_TURN document=${snapshot.documentId} index=99 role=notes id=new-tracker protected=false]]\nkey fact: 7`;
		const result = applyContextDocument(edited, snapshot, clm);

		assert.equal(result.accepted, true, result.reason);
		const trace = result.editTrace;
		assert.ok(trace?.additions.length, "the new block must be traced as an addition");
		for (const addition of trace?.additions ?? []) {
			assert.ok(
				addition.outputIndex < result.messages.length,
				`addition outputIndex ${addition.outputIndex} is outside the ${result.messages.length}-message projection`,
			);
		}
		const noteAddition = trace?.additions.find((addition) =>
			JSON.stringify(result.messages[addition.outputIndex]?.content ?? "").includes("key fact: 7"),
		);
		assert.ok(noteAddition, "the added notes block must have its own trace entry");
	});

	test("an orphaned tool result is dropped and later trace entries stay aligned", () => {
		const snapshot = snapshotOf(conversation());
		// Drop the assistant side of the second group: repair must drop its orphaned result.
		const edited = dropBlockById(snapshot, blockId(snapshot, 3));
		const result = applyContextDocument(edited, snapshot, clm);

		assert.equal(result.accepted, true, result.reason);
		assert.ok(
			!result.messages.some((message) => message.role === "toolResult" && message.toolCallId === "c2"),
			"the orphaned result must be dropped by group repair",
		);
		assertTraceAlignsWithOutput(result, snapshot);
	});

	test("editing the body of a tool-calling assistant drops its group, so trim results instead", () => {
		const snapshot = snapshotOf(conversation());
		const assistantId = blockId(snapshot, 1);
		const lines = snapshot.text.split("\n");
		const header = lines.findIndex((line) => line.startsWith("[[CTX_TURN ") && line.includes(`id=${assistantId} `));
		const next = lines.findIndex((line, index) => index > header && line.startsWith("[[CTX_TURN "));
		// Replace only that block's body, keeping its header — exactly what a tidy pass does.
		const edited = [...lines.slice(0, header + 1), "did the work", ...lines.slice(next)].join("\n");
		const result = applyContextDocument(edited, snapshot, clm);
		assert.equal(result.accepted, true, result.reason);
		assert.ok(
			!result.messages.some((message) => message.role === "toolResult" && message.toolCallId === "c1"),
			"the body no longer carries the call, so repair dropped the call and its result: trim a spent result block instead",
		);
		assert.ok(
			result.messages.some((message) => message.role === "toolResult" && message.toolCallId === "c2"),
			"unrelated groups stay",
		);
	});

	test("an edited body after a repaired group is traced to the edited message", () => {
		const snapshot = snapshotOf(conversation());
		const edited = dropBlockById(snapshot, blockId(snapshot, 2)).replace("the conclusion is 7", "7");
		const result = applyContextDocument(edited, snapshot, clm);

		assert.equal(result.accepted, true, result.reason);
		const trace = result.editTrace;
		assert.ok(trace);
		const editedEntry = trace.sources.find((source) => source.kind === "edited");
		assert.ok(editedEntry, "the shortened assistant turn must be traced as edited");
		const described = result.messages[editedEntry!.outputIndex!];
		assert.ok(
			JSON.stringify(described?.content ?? "").includes("7"),
			"the edited trace entry must point at the shortened body",
		);
		assertTraceAlignsWithOutput(
			{ ...result, editTrace: { ...trace, sources: trace.sources.filter((source) => source.kind === "kept") } },
			snapshot,
		);
	});
});
