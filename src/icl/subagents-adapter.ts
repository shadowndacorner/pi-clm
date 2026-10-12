import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi-native piece of the facebookresearch/context-language-models port (fork of @lolipopshock/pi-clm).
// See docs/icl.md for the task contract and provenance.

/**
 * Multi-agent context coexistence adapter (§1 of the fork roadmap).
 *
 * pi-subagents runs child pi agents with `--no-extensions` plus explicit
 * `--extension` paths from the *required child extensions* registry. Hosts
 * register entries in `session_start` via
 * `registerRequiredChildExtensions({ sessionId, extensions })` (see
 * pi-subagents docs/agents.md §required child extensions) and dispose them in
 * `session_shutdown`.
 *
 * This adapter registers this plugin as a required child extension so every
 * spawned child loads the same CLM entry: the parent keeps its context mirrored
 * as a file AND each child keeps its own private per-session mirror — contexts
 * coexist as files across agents.
 *
 * Config:
 * - `PI_CLM_SUBAGENTS=off|0|false` disables registration entirely.
 * - `PI_CLM_SUBAGENTS=on|1` forces it (registration failure becomes a warning).
 * - `PI_CLM_SUBAGENTS_MODULE` resolves the pi-subagents module from an explicit
 *   directory (used by tests and by setups where the bare specifier cannot be
 *   resolved from this package's tree).
 */

export const SUBAGENTS_EXTENSION_ID = "pi-clm";

export interface RequiredChildExtensionsRegistrar {
	registerRequiredChildExtensions(input: {
		sessionId: string;
		extensions: ReadonlyArray<{ id: string; path: string; requireForAllRunners?: true }>;
	}): { dispose(): void };
}

export interface Registration {
	dispose(): void;
}

export function buildRegistrationPayload(sessionId: string, entryFile: string): {
	sessionId: string;
	extensions: Array<{ id: string; path: string }>;
} {
	// Bounded, host-shaped validation mirroring pi-subagents' own rules so a bad
	// payload fails here with a clear message instead of inside the registry.
	const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
	if (!idPattern.test(SUBAGENTS_EXTENSION_ID) || sessionId.length > 256 || sessionId.trim() !== sessionId) {
		throw new Error(`invalid subagent registration payload (id '${SUBAGENTS_EXTENSION_ID}', session '${sessionId.slice(0, 32)}…')`);
	}
	const canonical = fs.realpathSync(path.resolve(entryFile));
	if (!fs.statSync(canonical).isFile()) throw new Error(`${canonical} is not a file`);
	if (Buffer.byteLength(canonical, "utf8") > 4096) throw new Error("entry path too long");
	return { sessionId, extensions: [{ id: SUBAGENTS_EXTENSION_ID, path: canonical }] };
}

type Importer = (specifier: string) => Promise<unknown>;

/** Candidate resolutions, best-first: bare specifier, explicit env dir, then the
 * managed npm tree pi itself installs packages into. */
export function registrarCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const explicit = env["PI_CLM_SUBAGENTS_MODULE"]?.trim();
	const candidates: string[] = [];
	if (explicit) {
		// A direct file is accepted (tests, vendored modules); a directory gets the
		// standard package layouts probed beneath it.
		let explicitFile = "";
		try {
			explicitFile = fs.statSync(path.resolve(explicit)).isFile() ? path.resolve(explicit) : "";
		} catch {
			explicitFile = "";
		}
		if (explicitFile) candidates.push(explicitFile);
		else {
			candidates.push(path.resolve(explicit, "src/api/required-child-extensions.js"));
			candidates.push(path.resolve(explicit, "index.js"));
		}
	}
	candidates.push("pi-subagents/required-child-extensions");
	const managed = env["PI_PACKAGE_DIR"]?.trim();
	if (managed) candidates.push(path.resolve(managed, "pi-subagents", "src", "api", "required-child-extensions.js"));
	// The managed npm tree is also reachable relative to pi's install root
	// (string join, not resolve: the ".." segment is the intended literal path).
	const managedInstall = env["PI_MANAGED_INSTALL_ROOT"]?.trim();
	if (managedInstall) {
		candidates.push(`${managedInstall.replace(/\/$/, "")}/../npm/node_modules/pi-subagents/src/api/required-child-extensions.js`);
	}
	const homeNpm = path.join(env["HOME"] ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents");
	candidates.push(path.join(homeNpm, "src", "api", "required-child-extensions.js"));
	candidates.push(path.join(homeNpm, "dist", "api", "required-child-extensions.js"));
	return candidates;
}

async function resolveRegistrar(env: NodeJS.ProcessEnv): Promise<RequiredChildExtensionsRegistrar | null> {
	// A child never loads pi-subagents (it runs --no-extensions): resolution
	// failure is the normal, silent end state there.
	const importer: Importer = (specifier) => import(specifier);
	for (const candidate of registrarCandidates(env)) {
		try {
			const mod = (await importer(candidate)) as { registerRequiredChildExtensions?: RequiredChildExtensionsRegistrar["registerRequiredChildExtensions"] };
			if (typeof mod?.registerRequiredChildExtensions === "function") {
				return { registerRequiredChildExtensions: mod.registerRequiredChildExtensions };
			}
		} catch {
			// Candidate miss — try the next one; end state is a silent skip.
			continue;
		}
	}
	return null;
}

export function entryFileFor(importMetaUrl: string): string {
	// src/icl/subagents-adapter.ts → package root index.ts (the clm entry).
	return fileURLToPath(new URL("../../index.ts", importMetaUrl));
}

function flagIs(env: NodeJS.ProcessEnv, name: string): boolean {
	const raw = env[name]?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function flagIsOff(env: NodeJS.ProcessEnv, name: string): boolean {
	const raw = env[name]?.trim().toLowerCase();
	return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

export interface AttachOptions {
	entryPath?: string;
	createRequireResolver?: boolean;
}

export interface SubagentsAdapter {
	register(options?: { sessionId?: string | null }): Promise<{ registered: boolean; reason?: string }>;
	dispose(): void;
	/** Current registration handle, or null before/after disposal. */
	readonly registration: Registration | null;
}

/** Attach the session-scoped registration/dispose lifecycle. Returns bookkeeping
 * used by unit tests; all failures are swallowed except explicit-force warnings. */
export function attachSubagentsAdapter(
	env: NodeJS.ProcessEnv,
	logWarning: (message: string) => void,
	options: AttachOptions & { parentDir?: string } = {},
): SubagentsAdapter {
	let registration: Registration | null = null;
	const entryPath = options.entryPath ?? entryFileFor(import.meta.url);
	return {
		get registration() {
			return registration;
		},
		async register(options: { sessionId?: string | null } = {}, envLocal = env): Promise<{ registered: boolean; reason?: string }> {
			if (flagIsOff(envLocal, "PI_CLM_SUBAGENTS")) return { registered: false, reason: "disabled by PI_CLM_SUBAGENTS" };
			try {
				if (registration) return { registered: true, reason: "already registered" };
				const registrar = await resolveRegistrar(envLocal);
				if (!registrar) {
					const message = "pi-subagents required child extension registry not found; subagent children will not load the CLM extension";
					if (flagIs(envLocal, "PI_CLM_SUBAGENTS")) logWarning(message);
					return { registered: false, reason: "registrar not found" };
				}
				const sessionId = options.sessionId ?? sessionIdOf(envLocal);
				if (!sessionId) return { registered: false, reason: "no session id" };
				registration = registrar.registerRequiredChildExtensions(
					buildRegistrationPayload(sessionId, entryPath) as never,
				);
				return { registered: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (flagIs(envLocal, "PI_CLM_SUBAGENTS")) logWarning(`pi-clm subagent registration failed: ${message}`);
				return { registered: false, reason: message };
			}
		},
		dispose(): void {
			try {
				registration?.dispose();
			} catch {
				// dispose is idempotent in the registry; double-dispose is safe.
			} finally {
				registration = null;
			}
		},
	};
}

function sessionIdOf(env: NodeJS.ProcessEnv): string {
	const direct = env["PI_CLM_SUBAGENTS_SESSION_ID"]?.trim();
	return direct || "";
}
