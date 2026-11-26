import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { renderContextDocument } from "../context-document.ts";
import { editShapeText, systemGuidance } from "../presentation.ts";
import type { ContextEditTrace, LiveContextMessage, LiveContextMessage as Msg } from "../types.ts";

const SKILL_DIR = join(import.meta.dirname, "..", "skills", "clm-live-context");
const HELPER = join(SKILL_DIR, "scripts", "clm-tidy.py");

const conversation: Msg[] = [
	{ role: "user", content: "count the lines of notes.txt", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "running wc" }], timestamp: 2 } as Msg,
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "1:apple\n2:banana\n".repeat(200) }],
		isError: false,
		timestamp: 3,
	} as Msg,
	{ role: "assistant", content: [{ type: "text", text: "notes.txt has 400 lines" }], timestamp: 4 } as Msg,
	{ role: "user", content: "now sort them by length", timestamp: 5 },
];

function fixture() {
	const snapshot = renderContextDocument(conversation, { revision: 4, protectedIndexes: new Set(), documentSeed: "s" });
	const dir = mkdtempSync(join(tmpdir(), "clm-tidy-"));
	const file = join(dir, "LIVE_CONTEXT.md");
	writeFileSync(file, snapshot.text);
	return { snapshot, file };
}

function run(args: string[]) {
	return spawnSync("python3", [HELPER, ...args], { encoding: "utf8" });
}

describe("CLM-mode system guidance", () => {
	const guidance = systemGuidance("/tmp/LIVE_CONTEXT.md", "clm");
	test("names the default operation as an in-place tidy with a worked example", () => {
		assert.match(guidance, /TIDY/);
		assert.match(guidance, /in place/i);
		assert.match(guidance, /TIDY:/, "the default arm must show an example, not only protocol");
		assert.match(guidance, /keep every\s+header you retain/i);
	});
	test("gives event triggers and an anti-trigger", () => {
		assert.match(guidance, /large tool result/i);
		assert.match(guidance, /task switch|task change/i);
		assert.match(guidance, /long (reasoning|analysis)/i);
		assert.match(guidance, /not tidy (after )?(every|each) turn/i);
	});
	test("demotes the whole-context rewrite to a declared, rare operation", () => {
		assert.match(guidance, /FULL REWRITE/);
		assert.match(guidance, /delete every \[\[CTX_TURN/);
		assert.match(guidance, /only when|last resort|exception/i);
		assert.doesNotMatch(guidance, /Alternatively, write the file as plain text/);
	});
	test("points at the checked helper and the two-question self-test", () => {
		assert.match(guidance, /clm-tidy/);
		assert.match(guidance, /self-test/i);
	});
	test("names the helper's absolute path when the extension knows it", () => {
		const concrete = systemGuidance("/tmp/LIVE_CONTEXT.md", "clm", "/opt/pi-clm/scripts/clm-tidy.py");
		assert.match(concrete, /python3 \/opt\/pi-clm\/scripts\/clm-tidy\.py --file \/tmp\/LIVE_CONTEXT\.md --list/);
	});
});

describe("CLM live-context skill", () => {
	test("ships as a discoverable skill directory", () => {
		assert.ok(existsSync(join(SKILL_DIR, "SKILL.md")));
		assert.match(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"), /^---\nname: clm-live-context/);
	});
	test("teaches the tidy pass, the self-test, and the helper, without a shrink mandate", () => {
		const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
		assert.match(skill, /TIDY is optional/);
		assert.match(skill, /self-test/i);
		assert.match(skill, /Which exact ids change/i);
		assert.match(skill, /clm-tidy/);
		assert.doesNotMatch(skill, /an edit must make the complete projection smaller/);
	});
});

describe("checked patch helper (clm-tidy)", () => {
	test("refuses a re-typed draft whose headers disagree with its metadata line", () => {
		const { snapshot, file } = fixture();
		const staleMeta = renderContextDocument(conversation, { revision: 4, protectedIndexes: new Set(), documentSeed: "other" });
		const tampered = snapshot.text.replace(snapshot.text.split("\n")[0]!, staleMeta.text.split("\n")[0]!);
		writeFileSync(file, tampered);
		const result = run(["--file", file, "--patch", `${snapshot.blocks[2]!.id}=wc: 400 lines`]);
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(`${result.stderr}${result.stdout}`.toLowerCase(), /stale/);
		assert.equal(readFileSync(file, "utf8"), tampered, "a refused patch must not write the mirror");
	});
	test("refuses an unknown id and names it", () => {
		const { file } = fixture();
		const result = run(["--file", file, "--patch", "9-deadbeef=nothing"]);
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(`${result.stderr}${result.stdout}`, /9-deadbeef/);
	});
	test("replaces one body in place, keeps every header, and reports shape", () => {
		const { snapshot, file } = fixture();
		const target = snapshot.blocks[2]!;
		const result = run(["--file", file, "--patch", `${target.id}=wc: 400 lines in notes.txt`]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const after = readFileSync(file, "utf8");
		assert.equal(
			after.split("\n").filter((line) => line.startsWith("[[CTX_TURN ")).length,
			snapshot.blocks.length,
			"a tidy must not drop headers",
		);
		assert.ok(after.includes("wc: 400 lines in notes.txt"));
		assert.ok(!after.includes("2:banana"), "the spent tool output is gone");
		assert.match(result.stdout.toLowerCase(), /kept/);
	});
	test("--drop removes a whole block; --dry-run writes nothing", () => {
		const { snapshot, file } = fixture();
		const target = snapshot.blocks[2]!;
		const dry = run(["--file", file, "--drop", target.id, "--dry-run"]);
		assert.equal(dry.status, 0, dry.stdout + dry.stderr);
		assert.equal(readFileSync(file, "utf8"), snapshot.text, "--dry-run must not write");
		const applied = run(["--file", file, "--drop", target.id]);
		assert.equal(applied.status, 0, applied.stdout + applied.stderr);
		const after = readFileSync(file, "utf8");
		assert.ok(!after.includes(`id=${target.id} `));
		assert.equal(after.split("\n").filter((line) => line.startsWith("[[CTX_TURN ")).length, snapshot.blocks.length - 1);
	});
	test("refuses to delete an owner turn", () => {
		const { snapshot, file } = fixture();
		const ownerTurn = snapshot.blocks.find((block) => block.role === "user" && block.body.includes("now sort them"))!;
		assert.ok(ownerTurn, "fixture must contain a later owner turn");
		const result = run(["--file", file, "--drop", ownerTurn.id]);
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(`${result.stderr}${result.stdout}`.toLowerCase(), /owner/);
	});
	test("an indented header example inside a body is content, not a malformed header", () => {
		const { snapshot, file } = fixture();
		const target = snapshot.blocks[2]!;
		// The example sits in a block the patch does not touch, so it must survive.
		const withExample = snapshot.text.replace(
			"notes.txt has 400 lines",
			'example shape:\n  [[CTX_TURN ... id=41 role=toolResult ...]] 4,000 lines\nnotes.txt has 400 lines',
		);
		writeFileSync(file, withExample);
		const result = run(["--file", file, "--patch", `${target.id}=wc: 400 lines`]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const after = readFileSync(file, "utf8");
		assert.ok(after.includes("[[CTX_TURN ... id=41 role=toolResult"), "the example inside the body is kept");
		assert.ok(after.includes("wc: 400 lines"));
	});
	test("a malformed header line is refused cleanly, not a crash", () => {
		const { snapshot, file } = fixture();
		const broken = snapshot.text.replace(" role=assistant ", " role=assistant missing=true ");
		writeFileSync(file, broken);
		const result = run(["--file", file, "--patch", `${snapshot.blocks[2]!.id}=x`]);
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.doesNotMatch(result.stderr, /Traceback/, result.stderr);
		assert.match(`${result.stderr}${result.stdout}`.toLowerCase(), /malformed|header/);
	});

	test("the preamble comment survives and the size report counts the pre-patch state", () => {
		const { snapshot, file } = fixture();
		const target = snapshot.blocks[2]!;
		const result = run(["--file", file, "--patch", `${target.id}=wc: 400 lines`]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const after = readFileSync(file, "utf8");
		assert.match(after, /# Edit bodies or delete editable CTX_TURN blocks/, "the leading comment must survive");
		const sizes = /([0-9]+) -> ([0-9]+) characters/.exec(result.stdout);
		assert.ok(sizes, result.stdout);
		assert.ok(Number(sizes![1]) > Number(sizes![2]), `a trim must report a larger before size: ${result.stdout}`);
	});

	test("an owner turn may be rewritten but never deleted", () => {
		const { snapshot, file } = fixture();
		const owner = snapshot.blocks.find((block) => block.role === "user" && block.body.includes("now sort them"))!;
		const rewritten = run(["--file", file, "--patch", `${owner.id}=[requirement withdrawn by the owner]`]);
		assert.equal(rewritten.status, 0, rewritten.stdout + rewritten.stderr);
		assert.match(readFileSync(file, "utf8"), /requirement withdrawn by the owner/);
	});

	test("--list prints only the metadata line and current headers", () => {
		const { snapshot, file } = fixture();
		const result = run(["--file", file, "--list"]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const printed = result.stdout.split("\n").filter(Boolean);
		assert.equal(printed.filter((line) => line.startsWith("[[CTX_TURN ")).length, snapshot.blocks.length);
		assert.ok(!result.stdout.includes("banana"), "--list must not print bodies");
	});
});

describe("edit shape reporting", () => {
	const trace: ContextEditTrace = {
		version: 1,
		sourceRevision: 4,
		sourceMessageCount: 5,
		outputMessageCount: 4,
		sources: [
			{ sourceIndex: 0, outputIndex: 0, kind: "kept" },
			{ sourceIndex: 1, outputIndex: 1, kind: "kept" },
			{ sourceIndex: 2, outputIndex: 2, kind: "edited" },
			{ sourceIndex: 3, outputIndex: 3, kind: "normalized" },
			{ sourceIndex: 4, kind: "removed" },
		],
		additions: [],
	};
	test("reports block shape alongside the size delta", () => {
		const text = editShapeText(trace)!;
		assert.match(text, /2 kept/i);
		assert.match(text, /2 edited in place/i);
		assert.match(text, /1 dropped/i);
	});
	test("names a full rewrite when the collapse path fired", () => {
		const collapse: ContextEditTrace = {
			...trace,
			sourceMessageCount: 40,
			outputMessageCount: 2,
			sources: [
				{ sourceIndex: 0, outputIndex: 0, kind: "kept" },
				...Array.from({ length: 39 }, (_, index) => ({ sourceIndex: index + 1, kind: "removed" as const })),
			],
			additions: [{ outputIndex: 1, kind: "added" as const }],
		};
		const text = editShapeText(collapse, ["Accepted a full rewrite: every block was replaced by one notes block."])!;
		assert.match(text, /full rewrite/i);
		assert.match(text, /39 dropped/i);
	});
});
