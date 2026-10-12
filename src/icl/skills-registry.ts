import fs from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The installed-skill registry: the bridge between evolved runs and daily use.
 *
 * Layout (under home, overridable via PI_CLM_SKILL_HOME for tests/containers):
 *
 *   <home>/skills/<sha8>.md      content-addressed skill files
 *   <home>/installed.json       versioned record: every install + current active
 *   <home>/active-skill.md      copy of the ACTIVE skill content; point
 *                               PI_CLM_STEERING at this path once, and
 *                               `pi-clm-skill use`/`--rollback` swap content.
 */
export interface InstalledRecord {
	seq: number;
	name: string;
	sha256: string;
	path: string;
	sourceRun: string | null;
	installedAt: string;
}

export interface RegistryFile {
	version: 1;
	nextSeq: number;
	installed: InstalledRecord[];
	/** The records (newest first) backing the current active file. */
	active: { seq: number; sha256: string; name: string } | null;
}

export function registryHome(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env["PI_CLM_SKILL_HOME"]?.trim();
	return custom || join(homedir(), ".pi", "agent", "clm");
}

export function activeSkillPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(registryHome(env), "active-skill.md");
}

/** The active file under an explicit home (tests/sync helpers that already know it). */
export function activeSkillPathFor(home: string): string {
	return join(home, "active-skill.md");
}

async function readRegistry(home: string): Promise<RegistryFile> {
	try {
		const parsed = JSON.parse(await readFile(join(home, "installed.json"), "utf8")) as RegistryFile;
		if (parsed && parsed.version === 1 && Array.isArray(parsed.installed)) return parsed;
	} catch {
		// fresh registry
	}
	return { version: 1, nextSeq: 1, installed: [], active: null };
}

async function writeRegistry(home: string, registry: RegistryFile): Promise<void> {
	await mkdir(home, { recursive: true });
	const tmp = join(home, "installed.json.tmp");
	await writeFile(tmp, `${JSON.stringify(registry, null, 1)}\n`, "utf8");
	await rename(tmp, join(home, "installed.json"));
}

function sha256Of(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function readSkill(source: string): Promise<string> {
	return readFile(source, "utf8");
}

/** Install a SKILL.md (or its directory) into the registry and activate it. */
export async function installSkill(options: {
	source: string;
	name?: string;
	sourceRun?: string | null;
	env?: NodeJS.ProcessEnv;
}): Promise<InstalledRecord & { firstInstall: boolean }> {
	const home = registryHome(options.env);
	const text = await readSkill(options.source);
	const sha = sha256Of(text);
	const skillsDir = join(home, "skills");
	const file = join(skillsDir, `${sha.slice(0, 8)}.md`);
	await mkdir(skillsDir, { recursive: true });
	await copyFile(options.source, file).catch(async () => {
		// copyFile keeps permissions; rewrite textually for cross-device sources
		await writeFile(file, text, "utf8");
	});
	const registry = await readRegistry(home);
	const existing = registry.installed.find((r) => r.sha256 === sha);
	if (existing) {
		registry.active = { seq: existing.seq, sha256: existing.sha256, name: existing.name };
		await writeRegistry(home, registry);
		await writeActiveFor(home, text);
		return { ...existing, firstInstall: false };
	}
	const record: InstalledRecord = {
		seq: registry.nextSeq,
		name: options.name ?? "",
		sha256: sha,
		path: file,
		sourceRun: options.sourceRun ?? null,
		installedAt: new Date().toISOString(),
	};
	registry.nextSeq += 1;
	registry.installed.push(record);
	registry.active = { seq: record.seq, sha256: record.sha256, name: record.name };
	await writeRegistry(home, registry);
	await writeActiveFor(home, text);
	return { ...record, firstInstall: true };
}

async function writeActiveFor(home: string, text: string): Promise<void> {
	const final = activeSkillPathFor(home);
	const tmp = `${final}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, final).catch(async () => {
		await writeFile(final, text, "utf8");
	});
}

/** Roll the active skill back to the previous installed version (non-active, newest first). */
export async function rollbackSkill(env: NodeJS.ProcessEnv = process.env): Promise<
	{ rolledBack: true; from: InstalledRecord; to: InstalledRecord } |
	{ rolledBack: false; reason: string }
> {
	const home = registryHome(env);
	const registry = await readRegistry(home);
	if (registry.installed.length < 2 || !registry.active) {
		return { rolledBack: false, reason: "no previous version to roll back to" };
	}
	const history = [...registry.installed].sort((a, b) => b.seq - a.seq);
	const current = history.find((r) => r.seq === registry.active!.seq);
	const previous = history.find((r) => r.seq !== registry.active!.seq)!;
	if (!current) return { rolledBack: false, reason: `active seq ${registry.active.seq} not found` };
	registry.active = { seq: previous.seq, sha256: previous.sha256, name: previous.name };
	await writeRegistry(home, registry);
	const text = await readFile(previous.path, "utf8");
	await writeActiveFor(home, text);
	return { rolledBack: true, from: current, to: previous };
}

/** The installed record for an active steering file, if the registry knows it. */
export async function describeInstalledSteering(env: NodeJS.ProcessEnv = process.env): Promise<InstalledRecord | null> {
	const home = registryHome(env);
	const registry = await readRegistry(home);
	if (!registry.active) return null;
	const match = registry.installed.find((r) => r.seq === registry.active!.seq);
	return match ?? null;
}

export async function registryStatus(env: NodeJS.ProcessEnv = process.env): Promise<{
	home: string;
	activeSkillPath: string;
	registry: RegistryFile;
}> {
	const home = registryHome(env);
	return { home, activeSkillPath: activeSkillPath(env), registry: await readRegistry(home) };
}

/** True when the file at path exists (used by tests and CLI messaging). */
export async function fileExists(path: string): Promise<boolean> {
	return await stat(path)
		.then(() => true)
		.catch(() => false);
}

/** Sync variant for panel/status rendering: the installed record if the steering
 * path is the registry's daily-driver file, else null. Never throws. */
export function installedForSteeringSync(steeringPath: string | undefined, env: NodeJS.ProcessEnv = process.env): InstalledRecord | null {
	try {
		if (!steeringPath) return null;
		if (resolve(fs.realpathSync(steeringPath)) !== resolve(fs.realpathSync(activeSkillPath(env)))) return null;
		const home = registryHome(env);
		const registry = JSON.parse(fs.readFileSync(join(home, "installed.json"), "utf8")) as RegistryFile;
		if (!registry?.active) return null;
		return registry.installed.find((r) => r.seq === registry.active!.seq) ?? null;
	} catch {
		return null;
	}
}
