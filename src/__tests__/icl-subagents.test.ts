import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildRegistrationPayload,
	entryFileFor,
	registrarCandidates,
} from "../icl/subagents-adapter.ts";

describe("subagents coexistence adapter", () => {
	test("entry file resolves to the package's CLM entry (index.ts)", () => {
		const entry = entryFileFor(new URL("../icl/subagents-adapter.ts", import.meta.url).href);
		assert.ok(entry.endsWith("/index.ts"), `unexpected entry ${entry}`);
		assert.ok(entry.startsWith(process.cwd()));
	});

	test("buildRegistrationPayload canonicalizes the entry file and validates inputs", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "clm-sub-"));
		const entry = join(tmp, "index.ts");
		await writeFile(entry, "export default function () {};\n");
		const payload = buildRegistrationPayload("sess-1", entry);
		assert.equal(payload.sessionId, "sess-1");
		assert.equal(payload.extensions.length, 1);
		assert.equal(payload.extensions[0]!.id, "pi-clm");
		assert.ok(payload.extensions[0]!.path.startsWith("/"));
		// Canonicalization collapses duplicate slashes / symlinks to realpath.
		assert.ok(!payload.extensions[0]!.path.includes("/./"));

		assert.throws(() => buildRegistrationPayload("  padded", entry));
		assert.throws(() => buildRegistrationPayload("sess-1", join(tmp, "missing.ts")));
		await rm(tmp, { recursive: true, force: true });
	});

	test("registrarCandidates prefers the explicit env module, then the managed trees", () => {
		const home = join(tmpdir(), `clm-home-${Date.now()}`);
		const candidates = registrarCandidates({
			PI_CLM_SUBAGENTS_MODULE: "/custom/subagents",
			PI_PACKAGE_DIR: "/pkg",
			PI_MANAGED_INSTALL_ROOT: "/install",
			HOME: home,
		});
		assert.ok(candidates[0]!.startsWith("/custom/subagents/src/api/required-child-extensions.js"));
		assert.ok(candidates.includes("pi-subagents/required-child-extensions"));
		assert.ok(candidates.some((c) => c.startsWith("/install/../npm/node_modules/pi-subagents")));
		assert.ok(candidates.some((c) => c === join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents", "src", "api", "required-child-extensions.js")));

		// No env hints at all: bare specifier + the HOME npm tree still resolve.
		const none = registrarCandidates({ HOME: home });
		assert.ok(none.includes("pi-subagents/required-child-extensions"));
		assert.ok(none.every((c) => c.length > 0));
	});

	test("attach: session_start registers through the injected module; shutdown disposes exactly once", async () => {
		const home = await mkdtemp(join(tmpdir(), "clm-sub-live-"));
		const log = join(home, "registry.log");
		process.env.MOCK_REGISTRY_LOG = log;
		process.env.PI_CLM_SUBAGENTS_MODULE = join(process.cwd(), "src", "__tests__", "fixtures", "mock-required-child-extensions.mjs");
		try {
			const { attachSubagentsAdapter } = await import("../icl/subagents-adapter.ts");
			const adapter = attachSubagentsAdapter({ ...process.env, PI_CLM_SUBAGENTS: "1" }, () => {
				throw new Error("no warnings expected on the happy path");
			});
			const apply = await adapter.register({ sessionId: "session-abc" });
			assert.ok(apply.registered, `register failed: ${apply.reason}`);

			const lines = (await readFile(log, "utf8")).trim().split("\n");
			assert.equal(lines.length, 1);
			const event = JSON.parse(lines[0]!);
			assert.equal(event.event, "register");
			assert.equal(event.sessionId, "session-abc");
			assert.equal(event.extensions[0].id, "pi-clm");
			assert.ok(String(event.extensions[0].path).endsWith("/index.ts"));

			// Idempotent: a second register keeps the single registration.
			await adapter.register({ sessionId: "session-abc" });
			assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);

			adapter.dispose();
			adapter.dispose(); // idempotent dispose
			const afterDispose = (await readFile(log, "utf8")).trim().split("\n");
			assert.equal(afterDispose.filter((l) => l.includes('"dispose"')).length, 1);
			assert.equal(adapter.registration, null);
		} finally {
			delete process.env.MOCK_REGISTRY_LOG;
			delete process.env.PI_CLM_SUBAGENTS_MODULE;
			await rm(home, { recursive: true, force: true });
		}
	});

	test("attach: PI_CLM_SUBAGENTS=off disables; explicit force warns when the module is missing", async () => {
		const { attachSubagentsAdapter } = await import("../icl/subagents-adapter.ts");
		const warnings: string[] = [];
		const off = attachSubagentsAdapter(
			{ PI_CLM_SUBAGENTS: "off", PI_CLM_SUBAGENTS_MODULE: "/nowhere-that-exists", HOME: tmpdir() },
			(message) => warnings.push(message),
		);
		const offResult = await off.register({ sessionId: "s" });
		assert.ok(!offResult.registered);
		assert.match(offResult.reason!, /disabled by PI_CLM_SUBAGENTS/);
		assert.equal(warnings.length, 0);

		const forced = attachSubagentsAdapter(
			{ PI_CLM_SUBAGENTS: "1", PI_CLM_SUBAGENTS_MODULE: "/nowhere-that-exists", HOME: join(tmpdir(), "clm-empty-home") },
			(message) => warnings.push(message),
		);
		const forcedResult = await forced.register({ sessionId: "s" });
		assert.ok(!forcedResult.registered);
		assert.ok(warnings.length >= 1, "explicit force must surface the failure as a warning");
		assert.equal(forced.registration, null);
	});

	test("dispose lifecycle: registration handle released after shutdown", async () => {
		// The adapter always nulls its handle after dispose.
		const { attachSubagentsAdapter } = await import("../icl/subagents-adapter.ts");
		process.env.MOCK_REGISTRY_LOG = join(tmpdir(), `clm-dispose-${Date.now()}.log`);
		process.env.PI_CLM_SUBAGENTS_MODULE = join(process.cwd(), "src", "__tests__", "fixtures", "mock-required-child-extensions.mjs");
		try {
			const adapter = attachSubagentsAdapter({ ...process.env }, () => undefined);
			const probe = await adapter.register({ sessionId: "s2" });
			assert.ok(probe.registered, `register failed: ${probe.reason}`);
			assert.ok(adapter.registration, "expected a live registration");
			adapter.dispose();
			assert.equal(adapter.registration, null);
		} finally {
			delete process.env.MOCK_REGISTRY_LOG;
			delete process.env.PI_CLM_SUBAGENTS_MODULE;
		}
	});
});
