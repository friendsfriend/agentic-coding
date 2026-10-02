// Live credentials from the user's global pi agent directory
// (durable-agent-configuration: "Live global credentials"). Implements
// pi-ai's `CredentialStore` contract directly against pi's own `auth.json`
// file — the exact file pi itself reads and writes — so a durable run
// authenticates with whatever the user already configured for `pi`, and
// never copies a credential value into agentic-coding's own configuration or
// workflow storage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mirrors `@earendil-works/pi-ai`'s `Credential` discriminated union. Kept
 * local rather than imported so this module's own type-check does not depend
 * on the experimental package's internal auth module path. */
export type PiCredential =
	| { type: "api_key"; key?: string; env?: Record<string, string> }
	| ({
			type: "oauth";
			refresh: string;
			access: string;
			expires: number;
	  } & Record<string, unknown>);
export interface PiCredentialInfo {
	providerId: string;
	type: PiCredential["type"];
}

/** pi's agent directory, honouring `PI_CODING_AGENT_DIR` like every other
 * global-pi integration in this codebase (`src/workflow/pi-tools.ts`). An
 * empty or blank override counts as unset. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return configured ? configured : path.join(os.homedir(), ".pi", "agent");
}
export function piAuthPath(agentDir: string = piAgentDir()): string {
	return path.join(agentDir, "auth.json");
}

function readAuthFile(authPath: string): Record<string, PiCredential> {
	try {
		const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, PiCredential>)
			: {};
	} catch {
		// Absent or unreadable: no stored credentials, never a durable-run failure.
		return {};
	}
}
function writeAuthFile(
	authPath: string,
	value: Record<string, PiCredential>,
): void {
	fs.mkdirSync(path.dirname(authPath), { recursive: true });
	const tmp = `${authPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, authPath);
}

/** A `CredentialStore`-shaped adapter over `auth.json`. Typed loosely
 * (`PiCredential`, not pi-ai's own `Credential`) so this module has no
 * compile-time dependency on `@earendil-works/pi-ai`'s auth module; the
 * structural shape matches, so `@earendil-works/pi-ai`'s `createModels({
 * credentials })` accepts it. `modify` serializes writes per process with an
 * in-memory queue; it does not take a cross-process file lock, matching the
 * README's "best-effort stores... are valid implementations" (no stronger
 * guarantee than pi's own CLI makes when a user edits `auth.json` by hand). */
export class PiAuthCredentialStore {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly authPath: string = piAuthPath()) {}

	async read(providerId: string): Promise<PiCredential | undefined> {
		return readAuthFile(this.authPath)[providerId];
	}
	async list(): Promise<readonly PiCredentialInfo[]> {
		const all = readAuthFile(this.authPath);
		return Object.entries(all).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}
	modify(
		providerId: string,
		fn: (
			current: PiCredential | undefined,
		) => Promise<PiCredential | undefined>,
	): Promise<PiCredential | undefined> {
		const next = this.queue.then(async () => {
			const all = readAuthFile(this.authPath);
			const updated = await fn(all[providerId]);
			if (updated === undefined) return all[providerId];
			all[providerId] = updated;
			writeAuthFile(this.authPath, all);
			return updated;
		});
		// Keep the queue alive even if this write rejects, and never let a
		// rejection become an unhandled rejection on the shared chain.
		this.queue = next.catch(() => undefined);
		return next;
	}
	async delete(providerId: string): Promise<void> {
		await this.queue;
		const all = readAuthFile(this.authPath);
		if (!(providerId in all)) return;
		delete all[providerId];
		writeAuthFile(this.authPath, all);
	}
}
