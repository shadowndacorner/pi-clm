import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { digestMessages } from "../context-document.ts";
import {
	applyProjection,
	attachSourceEntriesFromBranch,
	createProjectionCheckpoint,
	PROJECTION_NO_ENTRY_IDENTITY_REASON,
	reanchorProjection,
	recoverProjectionFromRetryErrors,
	toSourceEntryRefs,
} from "../projection.ts";
import {
	LIVE_CONTEXT_STATE,
	initialLiveContextState,
	reconstructLiveContextState,
	resetProjectionState,
	toOutcomeEntry,
} from "../state.ts";
import type { LiveContextMessage } from "../types.ts";

const raw: LiveContextMessage[] = [
	{ role: "user", content: "task", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "large investigation" }], timestamp: 2 },
	{ role: "user", content: "tool output".repeat(100), timestamp: 3 },
];
const projected: LiveContextMessage[] = [
	raw[0],
	{ role: "custom", customType: "live-context-projection", content: "Investigation summary", display: false, timestamp: 2 },
];

function checkpoint(revision = 1) {
	return createProjectionCheckpoint({
		revision,
		sourceMessages: raw,
		projectedMessages: projected,
		beforeEstimate: 1_200,
		afterEstimate: 30,
		createdAt: "2026-08-29T00:00:00.000Z",
	});
}

describe("projection rebasing", () => {
	test("replaces the source prefix and appends the raw suffix", () => {
		const suffix = [
			{ role: "assistant", content: [{ type: "text", text: "new turn" }], timestamp: 4 },
			{ role: "user", content: "new result", timestamp: 5 },
		];
		const result = applyProjection([...raw, ...suffix], checkpoint());
		assert.equal(result.valid, true);
		if (!result.valid) return;
		assert.deepEqual(result.messages, [...projected, ...suffix]);
		assert.deepEqual(result.suffix, suffix);
	});

	test("fails closed when the raw prefix changed", () => {
		const changed = raw.map((message) => ({ ...message }));
		changed[1] = { ...changed[1], content: "changed outside projection" };
		const result = applyProjection(changed, checkpoint());
		assert.equal(result.valid, false);
		assert.deepEqual(result.messages, changed);
		assert.match(result.valid ? "" : result.reason, /no longer matches/);
	});

	test("fails closed when the raw context is shorter than the anchor", () => {
		const result = applyProjection(raw.slice(0, 1), checkpoint());
		assert.equal(result.valid, false);
		assert.match(result.valid ? "" : result.reason, /shorter/);
	});

	test("no checkpoint returns a defensive top-level copy", () => {
		const result = applyProjection(raw, undefined);
		assert.equal(result.valid, true);
		assert.notEqual(result.messages, raw);
		assert.deepEqual(result.messages, raw);
	});

	test("checkpoint creation verifies JSON serialization", () => {
		const created = checkpoint();
		assert.doesNotThrow(() => JSON.stringify(created));
		assert.equal(created.sourceDigest, digestMessages(raw));
	});

	test("canonical message digests ignore object key order", () => {
		const left = [{ role: "user", content: "x", timestamp: 1 }];
		const right = [{ timestamp: 1, content: "x", role: "user" }];
		assert.equal(digestMessages(left), digestMessages(right));
	});

	test("recovers retry errors persisted by Pi but removed from its live agent state", () => {
		const anchorSource: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{ role: "assistant", content: "initial answer", stopReason: "stop", timestamp: 2 },
		];
		const anchor = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: anchorSource,
			projectedMessages: anchorSource,
			beforeEstimate: 20,
			afterEstimate: 20,
		});
		const successfulRetry: LiveContextMessage = {
			role: "assistant",
			content: "retry succeeded",
			stopReason: "stop",
			timestamp: 4,
		};
		const targetSource = [...anchorSource, successfulRetry];
		const targetProjection: LiveContextMessage[] = [
			anchorSource[0],
			{ role: "custom", content: "work completed", timestamp: 4 },
		];
		const target = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: targetSource,
			projectedMessages: targetProjection,
			beforeEstimate: 30,
			afterEstimate: 10,
		});
		const persistedRetryError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "fetch failed",
			timestamp: 3,
		};
		const laterError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "later terminal error",
			timestamp: 4.5,
		};
		const suffix: LiveContextMessage = { role: "user", content: "next task", timestamp: 5 };
		const resumedRaw = [...anchorSource, persistedRetryError, successfulRetry, laterError, suffix];

		assert.equal(applyProjection(resumedRaw, target).valid, false);
		const recovered = recoverProjectionFromRetryErrors(resumedRaw, target, [anchor, target]);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.removedErrorCount, 1);
		assert.equal(recovered.anchorRevision, 1);
		assert.deepEqual(recovered.messages, [...targetProjection, laterError, suffix]);
		assert.deepEqual(recovered.suffix, [laterError, suffix]);
	});

	test("retry recovery never ignores a changed non-error message", () => {
		const anchor = checkpoint(1);
		const target = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: [...raw, { role: "assistant", content: "success", stopReason: "stop", timestamp: 4 }],
			projectedMessages: projected,
			beforeEstimate: 1_300,
			afterEstimate: 30,
		});
		const resumed = [
			...raw,
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed", timestamp: 3.5 },
			{ role: "assistant", content: "different success", stopReason: "stop", timestamp: 4 },
		];
		const recovered = recoverProjectionFromRetryErrors(resumed, target, [anchor, target]);
		assert.equal(recovered.valid, false);
	});
});

describe("branch-local state reconstruction", () => {
	test("latest valid state on the supplied branch wins", () => {
		const first = { ...initialLiveContextState(), enabled: false };
		const latest = { ...initialLiveContextState(), revision: 2, checkpoint: checkpoint(2) };
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: first },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: { invalid: true } },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: latest },
		]);
		assert.deepEqual(reconstructed, latest);
	});

	test("another branch without an entry starts clean", () => {
		assert.deepEqual(reconstructLiveContextState([{ type: "message" }]), initialLiveContextState());
	});

	test("checkpoint-neutral outcome entries keep the active checkpoint", () => {
		const applied = { ...initialLiveContextState(), revision: 1, checkpoint: checkpoint(1) };
		const rejected = toOutcomeEntry({
			...applied,
			lastOutcome: { kind: "rejected", message: "edit grew", at: "2026-08-29T00:00:00.000Z" },
		});
		assert.equal("checkpoint" in rejected, false);
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: applied },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: rejected },
		]);
		assert.equal(reconstructed.lastOutcome?.kind, "rejected");
		assert.deepEqual(reconstructed.checkpoint, applied.checkpoint);
	});

	test("a persisted reset after an acceptance leaves no active checkpoint", () => {
		const applied = { ...initialLiveContextState(), revision: 1, checkpoint: checkpoint(1) };
		const reset = resetProjectionState(applied, "native compaction", "2026-08-29T00:00:00.000Z");
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: applied },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: reset },
		]);
		assert.equal(reconstructed.revision, 2);
		assert.equal(reconstructed.checkpoint, undefined);
	});

	test("reset clears the checkpoint and advances the revision", () => {
		const state = { ...initialLiveContextState(), revision: 4, checkpoint: checkpoint(4) };
		const reset = resetProjectionState(state, "native compaction", "2026-08-29T00:00:00.000Z");
		assert.equal(reset.revision, 5);
		assert.equal(reset.checkpoint, undefined);
		assert.equal(reset.lastOutcome?.kind, "reset");
	});
});


describe("recovering entry identity for older checkpoints", () => {
	const messages: LiveContextMessage[] = [
		{ role: "user", content: "task", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "verbose history" }], api: "a", provider: "p", model: "m", usage: { cost: { total: 0 } }, stopReason: "stop", timestamp: 2 },
		{ role: "user", content: "next", timestamp: 3 },
	];
	const branch = [
		{ id: "entry-1", messages: [messages[0]!] },
		{ id: "entry-2", messages: [messages[1]!] },
		{ id: "entry-3", messages: [messages[2]!] },
	];

	test("a positional-only checkpoint gains the branch's entry ids when the prefix matches", () => {
		const legacy = createProjectionCheckpoint({
			revision: 9,
			sourceMessages: messages,
			projectedMessages: [{ role: "user", content: "summary", timestamp: 1 }],
			beforeEstimate: 100,
			afterEstimate: 10,
			estimateUnit: "tokens",
		});
		assert.equal(legacy.sourceEntries, undefined);

		const healed = attachSourceEntriesFromBranch(legacy, branch);
		assert.ok(healed, "the branch reproduces the anchored prefix, so identity is recoverable");
		assert.deepEqual(healed!.sourceEntries!.map((entry) => entry.id), ["entry-1", "entry-2", "entry-3"]);

		// After an undo zeroes one entry, replay is decided by ids instead of discarding.
		const undone = [
			{ id: "entry-1", messages: [messages[0]!] },
			{ id: "edit-4", messages: [] },
			{ id: "entry-2", messages: [] },
			{ id: "entry-3", messages: [messages[2]!] },
		];
		const replay = reanchorProjection(undone, healed!);
		assert.equal(replay.valid, true, replay.valid ? "" : replay.reason);
		if (replay.valid) {
			assert.deepEqual(replay.deletedEntryIds, []);
			assert.deepEqual(replay.replacedEntryIds, ["entry-2"]);
			assert.equal(JSON.stringify(replay.messages).includes("verbose history"), false);
		}
	});

	test("identity is not fabricated when the branch does not reproduce the anchored prefix", () => {
		const legacy = createProjectionCheckpoint({
			revision: 9,
			sourceMessages: messages,
			projectedMessages: [{ role: "user", content: "summary", timestamp: 1 }],
			beforeEstimate: 100,
			afterEstimate: 10,
			estimateUnit: "tokens",
		});
		const foreign = [{ id: "entry-1", messages: [{ role: "user", content: "different", timestamp: 1 } as LiveContextMessage] }, ...branch.slice(1)];
		assert.equal(attachSourceEntriesFromBranch(legacy, foreign), undefined);
	});

	test("an entry that contributes no messages is never an insertion into the compacted range", () => {
		const covered = toSourceEntryRefs(branch);
		const checkpoint = createProjectionCheckpoint({
			revision: 9,
			sourceMessages: messages,
			sourceEntries: covered,
			projectedMessages: [{ role: "user", content: "summary", timestamp: 1 }],
			beforeEstimate: 100,
			afterEstimate: 10,
			estimateUnit: "tokens",
		});
		// A /tree undo of the middle entry appends a context_edit marker between covered entries.
		const withMarker = [branch[0]!, { id: "edit-4", messages: [] }, branch[1]!, branch[2]!];
		const replay = reanchorProjection(withMarker, checkpoint);
		assert.equal(replay.valid, true, replay.valid ? "" : replay.reason);
		assert.deepEqual(toSourceEntryRefs(withMarker).map((entry) => entry.id), ["entry-1", "entry-2", "entry-3"]);
	});
});

describe("a malformed edit trace does not discard the compaction it documents", () => {
	test("the newest checkpoint still restores when its trace points past the projected output", () => {
		const stale = createProjectionCheckpoint({
			revision: 9, sourceMessages: raw.slice(0, 2), projectedMessages: raw.slice(0, 1),
			beforeEstimate: 900, afterEstimate: 90, estimateUnit: "tokens",
		});
		const current = createProjectionCheckpoint({
			revision: 12, sourceMessages: raw, projectedMessages: raw.slice(0, 2),
			beforeEstimate: 26_770, afterEstimate: 18_117, estimateUnit: "tokens",
			// Synthetic malformed provenance with an outputIndex past the output.
			editTrace: {
				version: 1, sourceRevision: 11, sourceMessageCount: 128, outputMessageCount: 114,
				sources: [{ sourceIndex: 5, outputIndex: 300, kind: "kept" }], additions: [],
			},
		});
		const entries = [
			{ type: "custom", id: "s9", parentId: null, timestamp: "1", customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 9, checkpoint: stale } },
			{ type: "custom", id: "s12", parentId: "s9", timestamp: "2", customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 12, checkpoint: current } },
		];
		const restored = reconstructLiveContextState(entries);
		assert.equal(restored.revision, 12, `the newest compaction must survive a bad trace: got revision ${restored.revision}`);
		assert.equal(restored.checkpoint?.revision, 12);
		assert.equal(restored.checkpoint?.editTrace, undefined, "the unusable provenance is dropped, not the compaction");
	});
});
