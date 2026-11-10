import { digestMessages } from "./context-document.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const PROJECTION_PREFIX_MISMATCH_REASON =
	"Raw context prefix no longer matches the projection checkpoint.";

/**
 * Identity of one session entry covered by a checkpoint, taken from Pi's own entry tree
 * (`SessionManager.buildSessionProjection()`). Entry ids survive `/tree` navigation and
 * `context_edit` entries, while a positional raw prefix does not: anchoring to ids is what
 * lets a compaction be replayed onto a different active branch instead of being discarded.
 */
export interface ProjectionSourceEntry {
	id: string;
	digest: string;
	messageCount: number;
}

export interface ProjectionCheckpoint {
	version: 1;
	revision: number;
	sourceMessageCount: number;
	sourceDigest: string;
	/** Bounded prefix of the raw source covered by entry identity (see above). */
	sourceEntries?: ProjectionSourceEntry[];
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	/** Older checkpoints omitted this field and stored character estimates. */
	estimateUnit?: "characters" | "tokens";
	createdAt: string;
	/** Provenance for the accepted edit that produced projectedMessages. */
	editTrace?: ContextEditTrace;
}

export type ProjectionApplication =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
	  }
	| {
			valid: false;
			messages: LiveContextMessage[];
			reason: string;
	  };

export type ProjectionRecovery =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
			removedErrorCount: number;
			anchorRevision?: number;
	  }
	| {
			valid: false;
			reason: string;
	  };

function isPersistedRetryError(message: LiveContextMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error";
}

/**
 * An assistant turn that came back with no content at all and a provider-side stop reason.
 * This is a provider/transport outcome, not a context edit.
 * Surfacing it separately keeps that distinction visible instead of reading as lost context.
 */
export function emptyModelResponseReason(message: LiveContextMessage | undefined): "aborted" | "error" | undefined {
	if (!message || message.role !== "assistant") return undefined;
	const stopReason = message.stopReason;
	if (stopReason !== "aborted" && stopReason !== "error") return undefined;
	const content = Array.isArray(message.content) ? message.content : [];
	const carriesPayload = content.some((part) => {
		if (part === null || part === undefined || typeof part !== "object") return true;
		const record = part as Record<string, unknown>;
		if (record.type === "text") return typeof record.text === "string" && record.text.trim() !== "";
		if (record.type === "thinking") return typeof record.thinking === "string" && record.thinking.trim() !== "";
		return true;
	});
	if (carriesPayload) return undefined;
	return stopReason;
}

export function createProjectionCheckpoint(options: {
	revision: number;
	sourceMessages: LiveContextMessage[];
	sourceEntries?: ProjectionSourceEntry[];
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit?: "characters" | "tokens";
	createdAt?: string;
	editTrace?: ContextEditTrace;
}): ProjectionCheckpoint {
	const checkpoint: ProjectionCheckpoint = {
		version: 1,
		revision: options.revision,
		sourceMessageCount: options.sourceMessages.length,
		sourceDigest: digestMessages(options.sourceMessages),
		sourceEntries: options.sourceEntries,
		projectedMessages: [...options.projectedMessages],
		beforeEstimate: options.beforeEstimate,
		afterEstimate: options.afterEstimate,
		estimateUnit: options.estimateUnit,
		createdAt: options.createdAt ?? new Date().toISOString(),
		editTrace: options.editTrace,
	};

	// Fail at creation time rather than writing an unserializable custom session entry.
	JSON.stringify(checkpoint);
	return checkpoint;
}

/**
 * Replace the checkpoint's raw source prefix and retain every raw message appended after
 * it. A mismatch fails closed and returns the untouched raw context.
 */
export function applyProjection(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionApplication {
	if (!checkpoint) {
		return { valid: true, messages: [...rawMessages], suffix: [] };
	}
	if (checkpoint.version !== 1) {
		return { valid: false, messages: [...rawMessages], reason: `Unsupported projection version: ${checkpoint.version}.` };
	}
	if (rawMessages.length < checkpoint.sourceMessageCount) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: "Raw context is shorter than the projection source prefix.",
		};
	}

	const sourcePrefix = rawMessages.slice(0, checkpoint.sourceMessageCount);
	if (digestMessages(sourcePrefix) !== checkpoint.sourceDigest) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: PROJECTION_PREFIX_MISMATCH_REASON,
		};
	}

	const suffix = rawMessages.slice(checkpoint.sourceMessageCount);
	return {
		valid: true,
		messages: [...checkpoint.projectedMessages, ...suffix],
		suffix,
	};
}

/**
 * Pi persists failed assistant responses in JSONL before automatic retry, while its live
 * agent state removes those responses before retrying. A checkpoint accepted later in
 * that process therefore anchors to a prefix without the failed responses. On resume,
 * SessionManager reconstructs them and the otherwise unchanged prefix no longer hashes.
 *
 * Recover only when deleting assistant error responses after a cryptographically matching
 * older checkpoint (or from the beginning) makes the target checkpoint match exactly.
 * No user, successful assistant, or tool message is ever ignored by this compatibility
 * path. The caller should immediately rebase a recovered projection onto the resumed raw
 * transcript so future turns use the normal exact-prefix path again.
 */
export function recoverProjectionFromRetryErrors(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint,
	history: ProjectionCheckpoint[] = [],
): ProjectionRecovery {
	const direct = applyProjection(rawMessages, checkpoint);
	if (direct.valid) {
		return {
			...direct,
			removedErrorCount: 0,
		};
	}

	const candidates: Array<{ sourceMessageCount: number; sourceDigest?: string; revision?: number }> = [
		...history
			.filter((candidate) =>
				candidate.revision < checkpoint.revision &&
				candidate.sourceMessageCount <= checkpoint.sourceMessageCount &&
				rawMessages.length >= candidate.sourceMessageCount,
			)
			.sort((left, right) => right.sourceMessageCount - left.sourceMessageCount)
			.map((anchor) => ({
				sourceMessageCount: anchor.sourceMessageCount,
				sourceDigest: anchor.sourceDigest,
				revision: anchor.revision,
			})),
		{ sourceMessageCount: 0 },
	];
	const seenCounts = new Set<number>();

	for (const anchor of candidates) {
		if (seenCounts.has(anchor.sourceMessageCount)) continue;
		seenCounts.add(anchor.sourceMessageCount);
		const prefix = rawMessages.slice(0, anchor.sourceMessageCount);
		if (anchor.sourceDigest && digestMessages(prefix) !== anchor.sourceDigest) continue;
		const retainedSourceTail: LiveContextMessage[] = [];
		let cursor = anchor.sourceMessageCount;
		let removedErrorCount = 0;
		while (
			prefix.length + retainedSourceTail.length < checkpoint.sourceMessageCount &&
			cursor < rawMessages.length
		) {
			const message = rawMessages[cursor++];
			if (isPersistedRetryError(message)) removedErrorCount += 1;
			else retainedSourceTail.push(message);
		}
		if (removedErrorCount === 0) continue;

		// Only reconcile the target's source prefix. Later error responses are ordinary
		// suffix history and must not be silently removed by checkpoint recovery.
		const candidateMessages = [...prefix, ...retainedSourceTail, ...rawMessages.slice(cursor)];
		const recovered = applyProjection(candidateMessages, checkpoint);
		if (!recovered.valid) continue;
		return {
			...recovered,
			removedErrorCount,
			anchorRevision: anchor.revision,
		};
	}

	return {
		valid: false,
		reason: direct.reason,
	};
}

/** A session entry as the live branch presents it: stable id plus the messages it contributes. */
export interface BranchEntryLike {
	id: string;
	messages: LiveContextMessage[];
}

export function toSourceEntryRefs(entries: BranchEntryLike[]): ProjectionSourceEntry[] {
	return entries
		// An entry that contributes no messages carries no context. In pi that is a
		// `context_edit` marker (a `/tree` undo, or an externally rewritten entry): it occupies a
		// slot on the branch while adding nothing to the request, so it must never count as part
		// of, or as an insertion into, the compacted range.
		.filter((entry) => typeof entry.id === "string" && entry.id.length > 0 && entry.messages.length > 0)
		.map((entry) => ({
			id: entry.id,
			digest: digestMessages(entry.messages),
			messageCount: entry.messages.length,
		}));
}

export type ProjectionReanchoring =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
			deletedEntryIds: string[];
			replacedEntryIds: string[];
	  }
	| { valid: false; reason: string };

export const PROJECTION_NO_ENTRY_IDENTITY_REASON =
	"Projection checkpoint has no session-entry identity, so it cannot be replayed onto this branch.";

/**
 * Recover session-entry identity for a checkpoint written before CLM recorded it.
 *
 * Checkpoints from older builds anchor only a positional raw prefix, so any `/tree`
 * navigation invalidates that anchor and the projection used to be discarded outright — which
 * sent the whole raw transcript to the provider (HTTP 400 "request exceeds the context
 * window") while CLM's own meter kept quoting the compaction it no longer applied. When the
 * live branch still reproduces the anchored prefix message-for-message, that branch's stable
 * entry ids are exactly the ids the prefix was built from, so the checkpoint becomes
 * replayable across later `/tree` navigation instead of being thrown away.
 */
export function attachSourceEntriesFromBranch(
	checkpoint: ProjectionCheckpoint,
	branchEntries: BranchEntryLike[],
): ProjectionCheckpoint | undefined {
	if (checkpoint.sourceEntries && checkpoint.sourceEntries.length > 0) return undefined;
	const refs = toSourceEntryRefs(branchEntries);
	if (refs.length === 0) return undefined;

	const covered: ProjectionSourceEntry[] = [];
	const sourceMessages: LiveContextMessage[] = [];
	for (const ref of refs) {
		if (sourceMessages.length + ref.messageCount > checkpoint.sourceMessageCount) return undefined;
		const entry = branchEntries.find((candidate) => candidate.id === ref.id)!;
		covered.push(ref);
		sourceMessages.push(...entry.messages);
		if (sourceMessages.length === checkpoint.sourceMessageCount) break;
	}
	if (sourceMessages.length !== checkpoint.sourceMessageCount) return undefined;
	if (digestMessages(sourceMessages) !== checkpoint.sourceDigest) return undefined;
	return { ...checkpoint, sourceEntries: covered };
}

/**
 * Replay a checkpoint onto the branch that is actually live.
 *
 * The checkpoint's positional prefix digest is a fast path, not the source of truth: Pi's
 * `/tree` navigation records `context_edit` entries and re-roots the tree, so the same
 * managed compaction can be reached from a raw transcript whose prefix differs. Entry ids
 * are the durable identity, so replay is decided by them:
 *
 *  - a covered entry that is gone from the branch (a `/tree` undo, whose `replacement` is
 *    null) contributes nothing: it stays out of the sent context and the rest of the
 *    compaction is kept;
 *  - a covered entry whose content changed in place cannot be re-summarized here, so its
 *    raw messages are sent instead and reported as `replacedEntryIds`;
 *  - a branch that inserts entries inside the compacted range cannot be replayed at all:
 *    that fails closed rather than falling back to the raw transcript.
 */
/** Remove the first contiguous window of `size` projected messages hashing to `digest`. */
function removeWindow(messages: LiveContextMessage[], digest: string, size: number): boolean {
	for (let start = 0; start + size <= messages.length; start++) {
		if (digestMessages(messages.slice(start, start + size)) !== digest) continue;
		messages.splice(start, size);
		return true;
	}
	return false;
}

export function reanchorProjection(
	branchEntries: BranchEntryLike[],
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionReanchoring {
	if (!checkpoint) return { valid: true, messages: [], suffix: [], deletedEntryIds: [], replacedEntryIds: [] };
	const covered = checkpoint.sourceEntries;
	if (!covered || covered.length === 0) {
		return { valid: false, reason: PROJECTION_NO_ENTRY_IDENTITY_REASON };
	}

	const positions = new Map<string, number>();
	branchEntries.forEach((entry, index) => {
		if (!positions.has(entry.id)) positions.set(entry.id, index);
	});

	let previousCoveredIndex = -1;
	const coveredIndexes: number[] = [];
	const deletedEntryIds: string[] = [];
	for (const entry of covered) {
		const index = positions.get(entry.id);
		if (index === undefined) {
			deletedEntryIds.push(entry.id);
			continue;
		}
		if (index <= previousCoveredIndex) {
			return {
				valid: false,
				reason: `Session entry ${entry.id} moved inside the compacted range, so the projection cannot be replayed.`,
			};
		}
		previousCoveredIndex = index;
		coveredIndexes.push(index);
	}
	if (deletedEntryIds.length === covered.length) {
		return {
			valid: false,
			reason: "No session entry covered by the projection is present on this branch, so it cannot be replayed.",
		};
	}
	const lastCoveredIndex = coveredIndexes.at(-1) ?? -1;

	const suffix: LiveContextMessage[] = [];
	const replacedEntryIds: string[] = [];
	const coveredByIndex = new Map<number, ProjectionSourceEntry>();
	covered.forEach((entry, order) => {
		const index = positions.get(entry.id);
		if (index !== undefined) coveredByIndex.set(index, entry);
		void order;
	});

	const output = [...checkpoint.projectedMessages];
	// A covered entry that left the branch was undone (a `/tree` undo records a null
	// `context_edit`). Any projected copy of its exact messages goes with it; a message the
	// projection had already rewritten stays, because the summary is CLM-managed context and
	// re-summarizing is what the next compaction round is for.
	for (const id of deletedEntryIds) {
		const source = covered.find((entry) => entry.id === id);
		if (!source || source.messageCount === 0) continue;
		removeWindow(output, source.digest, source.messageCount);
	}

	for (let index = 0; index < branchEntries.length; index++) {
		const entry = branchEntries[index];
		const source = coveredByIndex.get(index);
		if (!source) {
			// A `/tree` undo appends a `context_edit` entry that contributes no messages. It is
			// not context and must not be mistaken for new content inserted inside the compacted
			// range, which previously discarded the compaction and sent the raw transcript.
			if (entry.messages.length === 0) continue;
			if (index < lastCoveredIndex) {
				return {
					valid: false,
					reason: `Session entry ${entry.id} was inserted inside the compacted range, so the projection cannot be replayed.`,
				};
			}
			suffix.push(...entry.messages);
			continue;
		}
		if (digestMessages(entry.messages) !== source.digest) {
			replacedEntryIds.push(entry.id);
			removeWindow(output, source.digest, source.messageCount);
			suffix.push(...entry.messages);
		}
	}

	return {
		valid: true,
		messages: [...output, ...suffix],
		suffix,
		deletedEntryIds,
		replacedEntryIds,
	};
}
