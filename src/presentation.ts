import type { ContextEditTrace } from "./types.ts";
import type { LiveContextState } from "./state.ts";

/** Provider-reported context size observed on the first request after an acceptance. */
export interface ObservedUsage {
	revision: number;
	tokens: number;
	percent: number;
}

export interface CurrentProjectionUsage {
	rawTokens: number;
	effectiveTokens: number;
}

export function contextMode(ctx: { mode?: unknown; hasUI: boolean }): string {
	return typeof ctx.mode === "string" ? ctx.mode : ctx.hasUI ? "tui" : "print";
}

export function formatCount(value: number): string {
	if (Math.abs(value) < 1_000) return String(value);
	if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function outcomeText(
	state: LiveContextState,
	observed?: ObservedUsage,
	current?: CurrentProjectionUsage,
): string {
	const checkpoint = state.checkpoint;
	if (!state.enabled) return `live ctx off · r${state.revision}`;
	const base = !checkpoint
		? `live ctx raw · r${state.revision}`
		: current
			? `live ctx ${formatCount(current.rawTokens)}→${formatCount(current.effectiveTokens)} tokens · r${state.revision}`
			: `live ctx ${formatCount(checkpoint.beforeEstimate)}→${formatCount(checkpoint.afterEstimate)} ${checkpoint.estimateUnit === "tokens" ? "tokens" : "chars"} · r${state.revision}`;
	if (observed && observed.revision === state.revision) {
		return `${base} · obs ${formatCount(observed.tokens)} tok`;
	}
	return base;
}

export function statusDetails(
	state: LiveContextState,
	mirrorPath: string | undefined,
	observed?: ObservedUsage,
	current?: CurrentProjectionUsage,
): string {
	const lines = [outcomeText(state, observed, current)];
	if (mirrorPath) lines.push(`mirror: ${mirrorPath}`);
	if (state.lastOutcome) lines.push(`${state.lastOutcome.kind}: ${state.lastOutcome.message}`);
	if (observed && observed.revision === state.revision) {
		lines.push(
			`observed: ${formatCount(observed.tokens)} tokens for revision ${observed.revision} · Pi window estimate ${observed.percent.toFixed(1)}%`,
		);
	}
	return lines.join("\n");
}

export function compositionWarningText(): string {
	return (
		"live-context: consecutive projections were invalidated before use. A context " +
		"transform from an earlier extension appears to change already-sent messages " +
		"between calls. Load live-context before such extensions, or disable it with " +
		"/live-context off."
	);
}

export function pressureNoticeText(percent: number, tier: number, mirrorPath: string | undefined): string {
	return (
		`[LIVE CONTEXT] Context usage is ${percent.toFixed(1)}% (crossed ${tier}%). ` +
		`Consider one batched mirror compaction at ${mirrorPath ?? "the live-context mirror"}.`
	);
}

/**
 * A per-revision shape report: what an accepted edit did to the block structure, not only how
 * many tokens it removed. Size alone rewards flattening; shape names it.
 */
export function editShapeText(
	trace: ContextEditTrace | undefined,
	diagnostics: readonly string[] = [],
): string | undefined {
	if (!trace) return undefined;
	let kept = 0;
	let inPlace = 0;
	let dropped = 0;
	let restored = 0;
	for (const source of trace.sources) {
		switch (source.kind) {
			case "kept":
				kept += 1;
				break;
			case "edited":
			case "normalized":
				inPlace += 1;
				break;
			case "removed":
				dropped += 1;
				break;
			case "restored":
				restored += 1;
				break;
		}
	}
	const parts = [`${kept} kept`, `${inPlace} shortened in place`, `${dropped} dropped`, `${trace.additions.length} added`];
	if (restored > 0) parts.push(`${restored} restored`);
	const collapsed = diagnostics.some((line) => /full rewrite|headerless rewrite/i.test(line));
	return `${collapsed ? "FULL REWRITE — " : ""}context shape: ${parts.join(", ")} (from ${trace.sourceMessageCount} blocks)`;
}

export function systemGuidance(
	path: string,
	editingMode: "conservative" | "clm" = "conservative",
	helperPath?: string,
): string {
	const helper = helperPath ?? "<skill directory>/scripts/clm-tidy.py";
	if (editingMode === "clm") return `## Editable context

Your working conversation is mirrored at \`${path}\` before every model request. What you write
there is what you will see next; raw Pi history stays intact. Your edit is validated at turn_end
and takes effect on the next request.

TIDY is the default operation: shorten or replace individual block bodies **in place**, keep every
header you retain, and touch only material your own work has made redundant. Do
not tidy after every turn — tidy when work has left spent material behind: a large tool result
you have already extracted facts from, a long reasoning or analysis turn whose conclusion is
recorded, a task switch that supersedes an earlier thread.

TIDY:
  before: [[CTX_TURN ... id=41 role=toolResult ...]]  4,000 lines of test output
  after:  [[CTX_TURN ... id=41 role=toolResult ...]]  test suite: 3 passed, T12 failed: expected 4, got 5 at src/x.ts:41
with that header and every other block left byte-identical.

Batch disjoint block edits into one write. "Batch" means many localized patches in a single
write, never one synthetic summary of the conversation. Trim tool-result bodies and tool-call-free
assistant bodies: editing the body of an assistant turn that made tool calls drops those calls,
and group repair then drops their results with them.

Before writing, run this self-test. (1) Which exact block ids am I changing, and what observed
fact makes what I remove spent, superseded, duplicated, or recoverable from a file? If unsure,
leave it. (2) Does the edit preserve every other body, the owner's requirements, unresolved work,
exact identifiers, and evidence that cannot be recovered? If either answer is no, do not make
that edit.

Prefer the checked helper to hand-rolled rewrites: \`python3 ${helper} --file ${path} --list\` prints the metadata line, current headers and block sizes; \`--patch
<id>=<new body>\` and \`--drop <id>\` apply localized changes, refuse a stale draft, and report
the resulting shape. \`--dry-run\` previews without writing.

Keep the LIVE_CONTEXT metadata line and every retained CTX_TURN header unchanged, and re-read
line 1 and the headers immediately before writing: headers must carry the current document
nonce. To add a block, copy a current header, give it a unique \`new-NAME\` id (for example
\`new-tracker\`), set
protected=false, and choose a role label (for example \`notes\`); ids of existing blocks come only
from current headers. Custom role labels are context notes, never provider system instructions.
Growth and same-size edits are allowed; neither guarantees that the next provider request fits.
Native Pi compaction remains enabled. Annotation tools preserve exact sources outside the mirror;
do not copy their notes into it. Only completed edits at the turn boundary are committed;
background writers are unsupported.

FULL REWRITE is the exception, not the default: delete every [[CTX_TURN ...]] header line and
write free text, which becomes one notes block placed after your owner turns. Reach for it only
when localized trims cannot free enough room for the next request, and state the reason in the
notes block. Never use it because the context feels untidy. A draft that still carries headers
from an earlier revision is rejected as stale — it is never treated as a rewrite.`;
	return `## Live context management

Your current model-visible conversation is mirrored at \`${path}\` before every model turn.
When history becomes stale or large, compact it by editing that file with the existing bash,
edit, or write tools. Keep the \`[[LIVE_CONTEXT ...]]\` and \`[[CTX_TURN ...]]\` metadata lines.
Default to surgical edits: preserve message order and complete user/assistant exchanges,
shorten stale bodies locally, and leave unrelated blocks unchanged. One batched mirror write may
contain many disjoint edits; it does not mean one global summary. Treat requests to keep messages
as exact retention of both user and assistant messages unless the user narrows the scope. Protected
turns are restored automatically. Do not read/cat the whole mirror: its content is already in your
context. If you need exact block IDs, use the live-context skill's header-only discovery command;
headers are bound to the current document nonce, so do not use an unfiltered grep for every \`[[\`
line. Active pin/continuity notes are extension-managed and may be appended outside the mirror;
do not copy them into it. A context edit must make the complete projection smaller and should be
the only mutation of the mirror in that assistant turn. The extension reports acceptance on the
next model call.`;
}
