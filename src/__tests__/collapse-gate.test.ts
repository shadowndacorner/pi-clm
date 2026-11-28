import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyContextDocument, renderContextDocument, repairToolGroups } from "../context-document.ts";
import type { ContextDocumentSnapshot, LiveContextMessage } from "../types.ts";

const clm = { editingMode: "clm" as const };

function conversation(): LiveContextMessage[] {
	return [
		{ role: "user", content: "find the secrets", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
			timestamp: 2,
		} as LiveContextMessage,
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "SECRET=42" }],
			isError: false,
			timestamp: 3,
		} as LiveContextMessage,
		{ role: "assistant", content: [{ type: "text", text: "found it: SECRET=42" }], timestamp: 4 } as LiveContextMessage,
		{ role: "user", content: "now write it to the report", timestamp: 5 },
	];
}

/** Remove one whole block (header + body) by header line index, and prove the body is gone. */
function deleteBlock(snapshot: ContextDocumentSnapshot, headerLine: number): string {
	const lines = snapshot.text.split(/\r?\n/);
	const nextHeader = lines.findIndex(
		(line, index) => index > headerLine && /^\[\[CTX_TURN /.test(line),
	);
	const end = nextHeader === -1 ? lines.length : nextHeader;
	return [...lines.slice(0, headerLine), ...lines.slice(end)].join("\n");
}

function headerLines(snapshot: ContextDocumentSnapshot, predicate: (header: string) => boolean): number[] {
	return snapshot.text
		.split(/\r?\n/)
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => /^\[\[CTX_TURN /.test(line) && predicate(line))
		.map(({ index }) => index);
}

describe("headerless collapse gate (CLM mode)", () => {
	test("a draft whose block headers carry an older nonce is rejected as stale, never collapsed", () => {
		// Two renderings of the same conversation at the same revision: the model re-typed a
		// mirror it had read earlier, so every header carries a nonce this document rejects.
		const staleRender = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "earlier-read" });
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "current" });
		assert.notEqual(staleRender.documentId, current.documentId);

		const result = applyContextDocument(staleRender.text, current, clm);

		assert.equal(result.accepted, false, result.reason);
		assert.match(result.reason ?? "", /stale|does not match/i, result.reason);
		assert.match(result.reason ?? "", /re-read|reread|headers/i, result.reason);
		assert.equal(
			result.diagnostics.join(" ").includes("full rewrite"),
			false,
			"a stale retype must never be recorded as an intentional whole-context rewrite",
		);
	});

	test("a draft from an older revision (old nonce, old revision) is rejected, not collapsed", () => {
		const messages = conversation();
		const older = renderContextDocument(messages, { revision: 0, protectedIndexes: new Set(), documentSeed: "seed-a" });
		const current = renderContextDocument(messages, { revision: 1, protectedIndexes: new Set(), documentSeed: "seed-b" });
		const result = applyContextDocument(older.text, current, clm);
		assert.equal(result.accepted, false, result.reason);
		assert.ok(result.messages.length === current.messages.length, "a rejected edit must not change the projection");
	});

	test("a draft of only malformed header-shaped lines is rejected as malformed, not collapsed", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const malformed = current.text
			.split(/\r?\n/)
			.map((line) => (line.startsWith("[[CTX_TURN ") ? "[[CTX_TURN id=broken]]" : line))
			.join("\n");
		const result = applyContextDocument(malformed, current, clm);
		assert.equal(result.accepted, false, result.reason);
		assert.match(result.reason ?? "", /malformed|stale/i, result.reason);
	});

	test("one re-typed header among valid ones is rejected rather than quietly deleting its block", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const older = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "older" });
		const currentHeaders = current.text.split("\n").filter((line) => line.startsWith("[[CTX_TURN document="));
		const olderHeaders = older.text.split("\n").filter((line) => line.startsWith("[[CTX_TURN document="));
		// A model that re-typed one header from an earlier read: the rest are current.
		const swapped = current.text.replace(currentHeaders[2]!, olderHeaders[2]!);
		const result = applyContextDocument(swapped, current, clm);
		assert.notEqual(currentHeaders[2], olderHeaders[2], "fixture must actually swap a header");
		assert.equal(result.accepted, false, result.reason);
		assert.match(result.reason ?? "", /another context revision|would be dropped/i, result.reason);
	});

	test("a header list quoted inside a body stays content when its blocks are still framed", () => {
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } as LiveContextMessage,
			{ role: "custom", customType: "header-list", content: "", display: false, timestamp: 3 } as LiveContextMessage,
		];
		const snapshot = renderContextDocument(messages, { revision: 1, protectedIndexes: new Set(), documentSeed: "s" });
		const quoted = snapshot.blocks
			.map((block) => block.header.replace(`document=${snapshot.documentId}`, `document=${"f".repeat(64)}`))
			.join("\n");
		const insertAt = snapshot.text.indexOf("\n\n") + 2;
		const withQuoted = `${snapshot.text.slice(0, insertAt)}quoted headers:\n${quoted}\n${snapshot.text.slice(insertAt)}`;
		const result = applyContextDocument(withQuoted, snapshot, clm);
		assert.equal(result.accepted, true, result.reason);
	});

	test("a declared headerless rewrite remains available and keeps every owner turn", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const summary = "# Context Summary\n## Found so far\n- SECRET=42\n## Next\n- write the report";
		const rewrite = `[[CLM REWRITE revision=0 document=${current.documentId} reason=localized trims cannot free enough room]]\n${summary}`;
		const result = applyContextDocument(rewrite, current, clm);

		assert.equal(result.accepted, true, result.reason);
		const keptUserTurns = result.messages.filter((message) => message.role === "user");
		assert.equal(keptUserTurns.length, 2, "a collapse may summarise the model's own work, not the owner's instructions");
		assert.deepEqual(
			result.editTrace?.sources.filter((source) => source.kind === "removed").map((source) => source.sourceIndex),
			[1, 2, 3],
		);
		assert.match(result.diagnostics.join(" "), /Accepted a full rewrite/);
	});

	test("rewrite declaration must be strictly single, leading, and syntactically complete", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const summary = "# Context Summary\n- rewrite body";
		const first = `[[CLM REWRITE revision=0 document=${current.documentId} reason=localized trims cannot free enough room]]`;

		const duplicate = `${first}\n${first}\n${summary}`;
		const duplicateResult = applyContextDocument(duplicate, current, clm);
		assert.equal(duplicateResult.accepted, false);
		assert.match(duplicateResult.reason ?? "", /additional|exactly one|after the first/i);

		const malformedSecond = `${first}\n[[CLM  REWRITE revision=0 document=${current.documentId} reason=second]]\n${summary}`;
		const malformedResult = applyContextDocument(malformedSecond, current, clm);
		assert.equal(malformedResult.accepted, false);
		assert.match(malformedResult.reason ?? "", /additional|malformed/i);

		const concatenated = `${first}[[CLM REWRITE revision=0 document=${current.documentId} reason=second]]\n${summary}`;
		const concatenatedResult = applyContextDocument(concatenated, current, clm);
		assert.equal(concatenatedResult.accepted, false);
		assert.match(concatenatedResult.reason ?? "", /complete line|multiple|embedded/i);
	});

	test("removing an owner turn's block is rejected; editing its body is allowed", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const [lastUserHeader] = headerLines(current, (line) => line.includes("role=user")).slice(-1);
		assert.notEqual(lastUserHeader, undefined);
		const edited = deleteBlock(current, lastUserHeader!);
		assert.equal(
			edited.includes("now write it to the report"),
			false,
			"the fixture must actually delete the block before asserting the harness reaction",
		);

		const result = applyContextDocument(edited, current, clm);
		assert.equal(result.accepted, false, result.reason);
		assert.match(result.reason ?? "", /owner turn|user turn/i, result.reason);

		// The same turn remains editable in CLM mode: retire it by rewriting its body.
		const retired = current.text.replace("now write it to the report", "[instruction withdrawn by the owner]");
		const retiredResult = applyContextDocument(retired, current, clm);
		assert.equal(retiredResult.accepted, true, retiredResult.reason);
	});

	test("removing an earlier owner turn's block is rejected too", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const [firstUserHeader] = headerLines(current, (line) => line.includes("role=user"));
		const edited = deleteBlock(current, firstUserHeader!);
		assert.equal(edited.includes("find the secrets"), false, "the fixture must actually delete the block");
		const result = applyContextDocument(edited, current, clm);
		assert.equal(result.accepted, false, result.reason);
		assert.match(result.reason ?? "", /owner turn|user turn/i, result.reason);
	});

	test("conservative mode keeps its own protected-turn behaviour", () => {
		const messages = conversation();
		const conservative = renderContextDocument(messages, { revision: 0 });
		const summary = "# Summary\n- SECRET=42";
		assert.equal(applyContextDocument(summary, conservative, {}).accepted, false, "headerless rewrites stay rejected in conservative mode");
	});
});

describe("CLM identity and tool-group invariants", () => {
	test("an owner block cannot be demoted to notes", () => {
		const current = renderContextDocument(conversation(), { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const demoted = current.text.replace("role=user id=", "role=notes id=");
		const result = applyContextDocument(demoted, current, clm);
		assert.equal(result.accepted, false, result.reason);
		assert.match(result.reason ?? "", /demoted|role=user/i, result.reason);
	});

	test("two calls with the same id inside one assistant message cannot be satisfied by one result", () => {
		const messages: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "dup", name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: "dup", name: "read", arguments: { path: "b" } },
				],
				timestamp: 2,
			} as LiveContextMessage,
			{ role: "toolResult", toolCallId: "dup", toolName: "read", content: [{ type: "text", text: "one result" }], timestamp: 3 } as LiveContextMessage,
		];
		const repaired = repairToolGroups(messages);
		assert.ok(repaired.some((message) => message.customType === "clm:terminal-incomplete" || message.customType === "clm:terminal-duplicate-group" || message.customType === "clm:terminal-duplicate-result"));
	});
});
