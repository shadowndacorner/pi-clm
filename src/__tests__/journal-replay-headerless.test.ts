import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	applyContextDocument,
	renderContextDocument,
} from "../context-document.ts";
import type { LiveContextMessage } from "../types.ts";

/** Synthetic regression coverage for headerless whole-file context rewrites. */
const messages = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "journal-01a1c286-window.json"), "utf8"),
) as LiveContextMessage[];

describe("synthetic headerless whole-file rewrite", () => {
	const snapshot = renderContextDocument(messages, {
		revision: 1,
		protectedIndexes: new Set<number>(),
		documentSeed: "synthetic",
	});

	test("synthetic fixture carries four user turns", () => {
		assert.equal(messages.filter((m) => m.role === "user").length, 4);
	});

	test("a headerless rewrite keeps every user turn instead of collapsing to one", () => {
		const freeText = "# Working notes\n\nSynthetic working notes for an example task.";
		const result = applyContextDocument(freeText, snapshot, { editingMode: "clm" });

		assert.equal(result.accepted, true);
		const usersBefore = messages.filter((m) => m.role === "user");
		const usersAfter = result.messages.filter((m) => m.role === "user");
		assert.equal(usersAfter.length, usersBefore.length, "no owner turn is collateral damage");
		usersBefore.forEach((original, i) => assert.equal(usersAfter[i], original, "owner turns survive verbatim"));
		assert.deepEqual(
			result.editTrace?.sources.filter((s) => s.kind === "removed").map((s) => s.sourceIndex),
			messages.map((_, i) => i).filter((i) => messages[i]!.role !== "user"),
			"only non-user messages are removed",
		);
	});

	test("conservative mode still refuses the same rewrite", () => {
		const result = applyContextDocument("# notes\n\nfree text", snapshot, { editingMode: "conservative" });
		assert.equal(result.accepted, false);
	});
});
