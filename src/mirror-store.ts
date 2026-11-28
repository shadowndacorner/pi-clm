import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const STALE_MIRROR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function safeSessionId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
	return safe || "session";
}

/**
 * Best-effort removal of mirror directories left behind by sessions that never reached
 * shutdown. Live sessions rewrite their mirror every turn, so a directory whose mtime
 * is older than the threshold has no owner. Failures are ignored: another process may
 * remove or own an entry concurrently.
 */
async function sweepStaleMirrors(parentDirectory: string, keepDirectory: string, maxAgeMs: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(parentDirectory);
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of names) {
		if (!name.startsWith("pi-live-context-")) continue;
		const directory = join(parentDirectory, name);
		if (directory === keepDirectory) continue;
		try {
			const info = await stat(directory);
			if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
			await rm(directory, { recursive: true, force: true });
		} catch {
			// Ignored: sweeping is opportunistic hygiene only.
		}
	}
}

export class MirrorStore {
	readonly directory: string;
	readonly filePath: string;
	private disposed = false;
	/** Monotonic generation of extension-authored mirror writes. */
	private generation = 0;

	private constructor(directory: string) {
		this.directory = directory;
		this.filePath = join(directory, "LIVE_CONTEXT.md");
	}

	static async create(
		sessionId: string,
		parentDirectory = tmpdir(),
		staleAgeMs = STALE_MIRROR_AGE_MS,
	): Promise<MirrorStore> {
		const prefix = join(parentDirectory, `pi-live-context-${safeSessionId(sessionId)}-`);
		const directory = await mkdtemp(prefix);
		await chmod(directory, 0o700);
		await sweepStaleMirrors(parentDirectory, directory, staleAgeMs).catch(() => undefined);
		return new MirrorStore(directory);
	}

	private publicationChain: Promise<void> = Promise.resolve();

	async write(content: string, generation = this.generation + 1): Promise<void> {
		// Serialize publications. Check the generation inside the lock and preserve
		// permissions on the temp file so a losing writer cannot rename rejected bytes.
		const run = this.publicationChain.then(async () => {
			if (this.disposed) throw new Error("Mirror store has been disposed.");
			const previousGeneration = this.generation;
			if (generation <= previousGeneration) {
				throw new Error("Stale mirror generation: a newer snapshot already exists.");
			}
			const temporaryPath = join(this.directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
			try {
				await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
				if (this.generation !== previousGeneration) {
					throw new Error("Mirror generation changed before publication.");
				}
				await rename(temporaryPath, this.filePath);
				this.generation = generation;
			} catch (error) {
				await rm(temporaryPath, { force: true }).catch(() => undefined);
				throw error;
			}
		});
		this.publicationChain = run.catch(() => undefined);
		return run;
	}

	/** Current extension-authored mirror generation; model edits do not advance it. */
	currentGeneration(): number {
		return this.generation;
	}

	async read(): Promise<string | undefined> {
		if (this.disposed) return undefined;
		try {
			return await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async cleanup(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await rm(this.directory, { recursive: true, force: true });
	}
}
