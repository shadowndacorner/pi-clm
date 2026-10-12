import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	activeSkillPath,
	describeInstalledSteering,
	installSkill,
	installedForSteeringSync,
	registryStatus,
	rollbackSkill,
} from "../icl/skills-registry.ts";
import liveContextExtension from "../index.ts";
import clmExtension from "../../index.ts";
import { spawnSync } from "node:child_process";

type Handler = (event: any, ctx: any) => any;

function fakeEnv(home: string): NodeJS.ProcessEnv {
	return { ...process.env, PI_CLM_SKILL_HOME: home };
}

async function makeHome(): Promise<string> {
	return await import("node:fs/promises").then((fs) =>
		fs.mkdtemp(join(tmpdir(), "clm-registry-")),
	);
}

describe("skills registry (daily-driver wiring)", () => {
	test("install → activate → rollback keeps a versioned record and rewrites the active file", async () => {
		const home = await makeHome();
		const env = fakeEnv(home);
		const { writeFile } = await import("node:fs/promises");
		const v1 = join(home, "v1");
		const v2 = join(home, "v2");
		await mkdir(v1, { recursive: true });
		await mkdir(v2, { recursive: true });
		await writeFile(`${v1}/SKILL.md`, "---\nname: one\n---\nfirst version\n");
		await writeFile(`${v2}/SKILL.md`, "---\nname: two\n---\nsecond version\n");

		const first = await installSkill({ source: `${v1}/SKILL.md`, name: "one", env });
		assert.ok(first.firstInstall);
		assert.equal(first.seq, 1);
		const activePath = activeSkillPath(env);
		assert.equal(await readFile(activePath, "utf8"), "---\nname: one\n---\nfirst version\n");

		// Re-installing the same content re-activates without a new version.
		const again = await installSkill({ source: `${v1}/SKILL.md`, env });
		assert.equal(again.firstInstall, false);
		assert.equal(again.seq, 1);

		const second = await installSkill({ source: `${v2}/SKILL.md`, name: "two", env });
		assert.equal(second.seq, 2);
		assert.equal(await readFile(activePath, "utf8"), "---\nname: two\n---\nsecond version\n");
		assert.equal((await describeInstalledSteering(env))?.name, "two");

		const rolled = await rollbackSkill(env);
		assert.ok(rolled.rolledBack);
		assert.equal(rolled.to.seq, 1);
		assert.equal(await readFile(activePath, "utf8"), "---\nname: one\n---\nfirst version\n");
		assert.equal((await describeInstalledSteering(env))?.name, "one");

		// Rollback on a fresh registry fails closed.
		const emptyHome = await makeHome();
		const emptyRoll = await rollbackSkill(fakeEnv(emptyHome));
		assert.ok(!emptyRoll.rolledBack);
	});

	test("pi-clm-skill use --run installs the run's winner; --rollback undoes it", async () => {
		const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
		const home = await mkdtemp(join(tmpdir(), "clm-use-"));
		// Minimal evolve-run fixture: state.json + skills/<incumbent>/SKILL.md.
		const runDir = join(home, "run");
		await mkdir(join(runDir, "skills", "r1-1-winner"), { recursive: true });
		await writeFile(
			join(runDir, "skills", "r1-1-winner", "SKILL.md"),
			"---\nname: winner-skill\n---\nKeep verified findings.\n",
		);
		await writeFile(
			join(runDir, "state.json"),
			JSON.stringify({ incumbent: "r1-1-winner", skills: {}, round: 1, noImprove: 0, history: [] }),
		);

		const skillHome = join(home, "registry");
		const result = spawnSync(
			process.execPath,
			[
				"--import", "tsx",
				join("bin", "pi-clm-skill.ts"),
				"use",
				"--run", runDir,
				"--home", skillHome,
			],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
		);
		assert.equal(result.status, 0, `use failed: ${result.stderr}`);
		assert.match(result.stdout, /installed winner-skill v1/);
		assert.match(result.stdout, /PI_CLM_STEERING=/);
		const active = await readFile(join(skillHome, "active-skill.md"), "utf8");
		assert.match(active, /winner-skill|Keep verified findings/);

		// Rollback through the CLI: single install → clean refusal (exit 1).
		const out = spawnSync(
			process.execPath,
			["--import", "tsx", join("bin", "pi-clm-skill.ts"), "use", "--rollback", "--home", skillHome],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
		);
		assert.equal(out.status, 1);
		assert.match(out.stderr, /no previous version/);

		await rm(home, { recursive: true, force: true });
	});

	test("/clm status shows the installed skill identity for registry-managed steering", async () => {
		const home = await makeHome();
		const env = fakeEnv(home);
		const { writeFile } = await import("node:fs/promises");
		const src = join(home, "running-skill");
		await mkdir(src, { recursive: true });
		await writeFile(`${src}/SKILL.md`, "---\nname: daily-driver\n---\nbe terse, keep findings\n");
		await installSkill({ source: `${src}/SKILL.md`, name: "daily-driver", sourceRun: "runs/evo-demo", env });
		process.env.PI_CLM_SKILL_HOME = home;
		process.env.PI_CLM_STEERING = activeSkillPath(env);
		try {
			const handlers = new Map<string, Handler[]>();
			const commands = new Map<string, any>();
			const branch: any[] = [];
			const notifications: string[] = [];
			const pi = {
				on(name: string, handler: Handler) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
				registerCommand(name: string, command: any) {
					commands.set(name, command);
				},
				registerTool() {},
				appendEntry() {},
				sendUserMessage() {},
			} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
			const ctx = {
				mode: "tui",
				hasUI: true,
				cwd: process.cwd(),
				ui: {
					setStatus() {},
					notify(message: string) {
						notifications.push(message);
					},
				},
				sessionManager: {
					getSessionId: () => "registry-panel-session",
					getSessionFile: () => "/tmp/registry-panel.jsonl",
					getBranch: () => [...branch],
					getEntries: () => [...branch],
					getEntry: (id: string) => branch.find((entry) => entry.id === id),
					buildContextEntries: () => [],
					getTree: () => [],
					getLeafId: () => null,
				},
				waitForIdle: async () => {},
				isIdle: () => true,
				getContextUsage: () => undefined,
			};
			clmExtension(pi);
			const emit = async (name: string, event: any): Promise<void> => {
				for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
			};
			await emit("session_start", { type: "session_start", reason: "startup" });
			await emit("context", {
				type: "context",
				messages: [
					{ role: "user", content: [{ type: "text", text: "task" }] },
				],
			});
			const command = commands.get("clm");
			assert.ok(command, "the extension should register its command");
			// Outside the TUI, /clm config prints the full status + settings text
			// (the same block the panel shows on the steering row).
			const prevMode = ctx.mode;
			ctx.mode = "rpc";
			try {
				await command.handler("config", ctx);
			} finally {
				ctx.mode = prevMode;
			}
			const status = notifications.join("\n");
			assert.match(status, /steering active-skill\.md/);
			assert.match(status, /installed: daily-driver v1 · from runs\/evo-demo/);
		} finally {
			Reflect.deleteProperty(process.env, "PI_CLM_SKILL_HOME");
			Reflect.deleteProperty(process.env, "PI_CLM_STEERING");
			const { rm } = await import("node:fs/promises");
			await rm(home, { recursive: true, force: true });
		}
	});

	test("status record includes every installed version", async () => {
		const home = await makeHome();
		const env = fakeEnv(home);
		const { writeFile, rm } = await import("node:fs/promises");
		const a = join(home, "a");
		const b = join(home, "b");
		await mkdir(a, { recursive: true });
		await mkdir(b, { recursive: true });
		await writeFile(`${a}/SKILL.md`, "---\nname: alpha\n---\nA\n");
		await writeFile(`${b}/SKILL.md`, "---\nname: beta\n---\nB\n");
		await installSkill({ source: `${a}/SKILL.md`, name: "alpha", env });
		await installSkill({ source: `${b}/SKILL.md`, name: "beta", env });
		const status = await registryStatus(env);
		assert.equal(status.registry.installed.length, 2);
		assert.equal(status.registry.active!.name, "beta");
		await rm(home, { recursive: true, force: true });
	});
});
