import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildTidyPrompt, tidyPromptFromEnv, DEFAULT_TIDY_PROMPT, loadTidyPrompt } from "../tidy.ts";
import { settingDescriptor } from "../settings.ts";

describe("/clm-tidy", () => {
	test("the prompt fills placeholders, leaves unknown ones, and drops the empty instructions line", () => {
		const values = { mirror: "/tmp/LIVE_CONTEXT.md", current: 110_000, budget: 1_000_000 };
		const prompt = buildTidyPrompt(DEFAULT_TIDY_PROMPT, values);
		assert.match(prompt, /^Free room in your live context/);
		assert.match(prompt, /about 110k tokens \(budget 1m\)\. Your context is mirrored at `\/tmp\/LIVE_CONTEXT\.md`/);
		assert.doesNotMatch(prompt, /\{\{|Also:|\n{3}/);
		assert.match(buildTidyPrompt(DEFAULT_TIDY_PROMPT, { ...values, instructions: " keep ids " }), /\n\nAlso: keep ids\n\n/);
		assert.equal(buildTidyPrompt("{{current}}{{budget}} {{other}}", { ...values, budget: undefined }), "110k {{other}}");
		assert.equal(buildTidyPrompt("{{constructor}} {{__proto__}} {{toString}}", values), "{{constructor}} {{__proto__}} {{toString}}", "only its own placeholders are filled");
		assert.equal(buildTidyPrompt("Shrink {{mirror}}.", { ...values, instructions: "keep ids" }), "Shrink /tmp/LIVE_CONTEXT.md.\n\nAlso: keep ids", "typed instructions are never dropped");
		assert.equal(buildTidyPrompt("A\n\n\n\nB\n\n{{instructions}}\n\nC", values), "A\n\n\n\nB\n\nC", "only the empty slot's blank lines collapse");
		assert.equal(buildTidyPrompt("A {{instructions}}B", values), "A B");
	});

	test("the tidy prompt setting takes a typed path (a cycle would lose it) and env keywords mean built in", () => {
		const descriptor = settingDescriptor("tidy-prompt")!;
		assert.equal(descriptor.choices, undefined);
		assert.ok(descriptor.placeholder);
		assert.deepEqual(descriptor.parse("default", ""), { tidyPrompt: null });
		assert.equal(tidyPromptFromEnv({ PI_CLM_TIDY_PROMPT: " Default " }), undefined);
		assert.equal(tidyPromptFromEnv({ PI_CLM_TIDY_PROMPT: "off" }), undefined);
		assert.equal(tidyPromptFromEnv({ PI_CLM_TIDY_PROMPT: "prompts/team.md" }), "prompts/team.md");
	});

	test("a custom template is read on use; missing or empty files are errors", async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "clm-tidy-test-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const path = join(directory, "prompt.md");
		assert.equal(loadTidyPrompt(undefined), DEFAULT_TIDY_PROMPT);
		await writeFile(path, "  Compact {{mirror}}.  \n");
		assert.equal(loadTidyPrompt(path), "Compact {{mirror}}.");
		await writeFile(path, "\n");
		assert.throws(() => loadTidyPrompt(path), /tidy prompt is empty/);
		assert.throws(() => loadTidyPrompt(join(directory, "missing.md")), /tidy prompt not loaded: ENOENT/);
	});
});
