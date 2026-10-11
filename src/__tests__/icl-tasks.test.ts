import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadDirTaskSource } from "../icl/tasks.ts";

test("DirTaskSource stores absolute task paths regardless of cwd-relative spec", async () => {
	const source = await loadDirTaskSource("eval/tasks");
	for (const dir of source.dirs()) {
		assert.ok(dir.startsWith("/"), `task path must be absolute, got ${dir}`);
	}
	const ids = source.taskIds();
	assert.ok(ids.includes("fruits"));
	assert.ok(ids.length >= 6);
});
