import { pathToFileURL } from "node:url";
import { digest, object } from "../config.ts";
import { EnvironmentCommands } from "./command.ts";
import type { ContainerProcess } from "./container.ts";

type Member = {
	aliases: string[];
	children: Set<ContainerProcess>;
	pending: number;
};

import type { Plan } from "./model.ts";
import type { RuntimeStatus } from "./process.ts";
import type { processEnvironment } from "./shell.ts";

const hostLabel = "dev.agentic-coding.v2.host",
	runLabel = "dev.agentic-coding.v2.run";
type Observation = {
	id: string;
	name: string;
	labels: Record<string, string>;
	attachments: string[];
};
function parse(raw: string): Observation {
	try {
		const result: unknown = JSON.parse(raw);
		if (!Array.isArray(result) || result.length !== 1) throw new Error();
		const value = object(result[0]),
			// Docker reports PascalCase fields, Podman lowercase ones; both
			// describe the same inspected network and are validated identically.
			labels = object(value.Labels ?? value.labels ?? {}),
			attachments = object(value.Containers ?? value.containers ?? {});
		const id = value.Id ?? value.id,
			name = value.Name ?? value.name;
		if (
			typeof id !== "string" ||
			!/^[a-f0-9]{64}$/.test(id) ||
			typeof name !== "string" ||
			Object.values(labels).some((value) => typeof value !== "string") ||
			Object.keys(attachments).length > 1024 ||
			Object.keys(attachments).some((id) => !/^[a-f0-9]{64}$/.test(id))
		)
			throw new Error();
		return {
			id,
			name,
			labels: labels as Record<string, string>,
			attachments: Object.keys(attachments),
		};
	} catch {
		throw new Error(
			"Invalid private network observation; absence is not confirmed",
		);
	}
}
function budget(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	return () => {
		const remaining = deadline - Date.now();
		if (!Number.isFinite(remaining) || remaining <= 0)
			throw new Error("Compose network operation timed out");
		return remaining;
	};
}
/** Only the ID returned by this live create grants authority. A name or copied
 * labels, including persisted diagnostics, can never authorize removal. */
export class ComposeNetwork {
	private members = new Map<symbol, Member>();
	private observing: Promise<void> = Promise.resolve();
	private closing = false;
	private commands: EnvironmentCommands;
	private provider: "docker" | "podman";
	private createdId: string | null = null;
	private mayHaveCreated = false;
	private uncertain = false;
	private host: string;
	private name: string;
	private failure = "";
	private observed: RuntimeStatus;
	constructor(
		plan: Plan,
		configDir: string,
		stateDir: string,
		private run: string,
		startupEnvironment?: ReturnType<typeof processEnvironment>,
	) {
		const provider = plan.compose?.provider;
		if (provider !== "docker" && provider !== "podman")
			throw new Error(
				"Shared Compose networking requires an explicit Docker or Podman provider with immutable network creation identity",
			);
		if (!plan.compose?.socket)
			throw new Error(
				"Shared Compose networking requires an explicit local socket",
			);
		this.provider = provider;
		this.host = digest(stateDir);
		this.name = `acv2-${plan.app}-${this.host.slice(0, 8)}-default`;
		this.commands = new EnvironmentCommands(
			plan,
			configDir,
			provider,
			provider === "docker"
				? ["--host", `unix://${plan.compose.socket}`]
				: [
						"--url",
						pathToFileURL(plan.compose.socket).href.replace(/^file:/, "unix:"),
					],
			startupEnvironment,
		);
		this.observed = {
			runtime: provider,
			kind: "network",
			name: this.name,
			id: null,
			state: "unknown",
			health: null,
			owned: null,
			observedAt: Date.now(),
		};
	}
	get cleanupFailed() {
		return (
			this.uncertain ||
			this.commands.cleanupFailed ||
			this.commands.uncertainEffect
		);
	}
	get runtimeStatus() {
		return { ...this.observed };
	}
	get logs() {
		return `${this.commands.logs}${this.failure ? `\n${this.failure}\n` : ""}`;
	}
	private async observe(timeoutMs: number, signal?: AbortSignal) {
		const remaining = budget(timeoutMs);
		try {
			const listed = await this.commands.checked(
				[
					"network",
					"ls",
					"--filter",
					`name=${this.name}`,
					"--no-trunc",
					"--format",
					"{{.ID}}",
				],
				{ timeoutMs: remaining(), signal, machine: true },
			);
			const ids = listed.trim() ? listed.trim().split(/\s+/) : [];
			if (
				ids.length > 64 ||
				ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
				new Set(ids).size !== ids.length
			)
				throw new Error("Invalid network listing");
			let found: Observation | null = null;
			for (const id of ids) {
				const candidate = parse(
					await this.commands.checked(["network", "inspect", id], {
						timeoutMs: remaining(),
						signal,
						machine: true,
					}),
				);
				if (candidate.id !== id)
					throw new Error("Network listing identity mismatch");
				if (candidate.name !== this.name) continue;
				if (found) throw new Error("Ambiguous network name");
				found = candidate;
			}
			this.observed = {
				...this.observed,
				id: found?.id ?? null,
				state: found ? "running" : "absent",
				owned: found
					? found.labels[hostLabel] === this.host &&
						found.labels[runLabel] === this.run
						? this.createdId === null
							? null
							: found.id === this.createdId
						: false
					: null,
				observedAt: Date.now(),
			};
			return found;
		} catch {
			this.observed = {
				...this.observed,
				state: "unknown",
				owned: null,
				observedAt: Date.now(),
			};
			throw new Error("Network observation failed; absence is not confirmed");
		}
	}
	private owned(observation: Observation) {
		if (
			!this.createdId ||
			observation.id !== this.createdId ||
			observation.labels[hostLabel] !== this.host ||
			observation.labels[runLabel] !== this.run
		)
			throw new Error(
				"Network ownership or live creation identity could not be verified; refusing mutation",
			);
	}
	async start(timeoutMs: number, signal?: AbortSignal) {
		if (this.closing) throw new Error("Original bridge admission is closed");
		const remaining = budget(timeoutMs);
		try {
			if (await this.observe(remaining(), signal))
				throw new Error(
					"The Compose network name is occupied; no existing network was adopted",
				);
			this.mayHaveCreated = true;
			const receipt = (
				await this.commands.checked(
					[
						"network",
						"create",
						"--driver",
						"bridge",
						"--label",
						`${hostLabel}=${this.host}`,
						"--label",
						`${runLabel}=${this.run}`,
						this.name,
					],
					{ timeoutMs: remaining(), signal, machine: true, effect: true },
				)
			).trim();
			if (this.provider === "docker") {
				if (!/^[a-f0-9]{64}$/.test(receipt)) {
					this.uncertain = true;
					throw new Error("Invalid live network creation receipt");
				}
				this.createdId = receipt;
			} else {
				// Podman returns the claimed name rather than an ID receipt. The
				// creation identity is read back through one label-verified
				// inspect of that name: creation succeeded only after the
				// occupied check, so a conflicting name fails the create itself
				// and is never adopted here.
				if (receipt !== this.name) {
					this.uncertain = true;
					throw new Error("Invalid live Podman network creation receipt");
				}
				const created = await this.observe(remaining(), signal);
				if (!created) {
					this.uncertain = true;
					throw new Error("Created Podman network disappeared");
				}
				if (
					created.name !== this.name ||
					created.labels[hostLabel] !== this.host ||
					created.labels[runLabel] !== this.run
				) {
					this.uncertain = true;
					throw new Error(
						"Podman network creation receipt ownership mismatch; refusing adoption",
					);
				}
				this.createdId = created.id;
			}
			await this.attachment(remaining(), signal);
		} catch (error) {
			this.failure =
				error instanceof Error
					? error.message
					: "Compose network startup failed";
			throw error;
		}
	}
	/** Claims only aliases, never an engine resource. Live membership handles
	 * never cross the wire or survive restart. Reservations are atomic. */
	join(aliases: string[]) {
		if (
			this.closing ||
			this.cleanupFailed ||
			this.members.size >= 64 ||
			!aliases.length ||
			aliases.length > 16 ||
			new Set(aliases).size !== aliases.length ||
			aliases.some((alias) => !/^[a-z][a-z0-9-]{0,62}$/.test(alias))
		)
			throw new Error("Invalid or closing live bridge membership");
		const occupied = new Set(
			[...this.members.values()].flatMap((member) => member.aliases),
		);
		if (aliases.some((alias) => occupied.has(alias)))
			throw new Error(
				"Cross-stack bridge service aliases conflict; no ambiguous DNS alias is attached",
			);
		const key = Symbol("native-compose-bridge-member");
		this.members.set(key, {
			aliases: [...aliases],
			children: new Set(),
			pending: 0,
		});
		return new ComposeNetworkMember(this, key);
	}
	begin(key: symbol, child: ContainerProcess) {
		const member = this.members.get(key);
		if (
			!member ||
			this.closing ||
			this.cleanupFailed ||
			member.children.has(child) ||
			member.children.size >= member.aliases.length
		)
			throw new Error("Original bridge membership is unavailable");
		member.children.add(child);
		member.pending++;
		let settled = false;
		return () => {
			if (!settled) {
				settled = true;
				member.pending--;
			}
		};
	}
	release(key: symbol) {
		const member = this.members.get(key);
		if (!member) return;
		if (
			member.pending ||
			[...member.children].some(
				(child) =>
					!child.outcome ||
					(child.cleanupFailed && child.runtimeStatus?.state !== "absent"),
			)
		) {
			this.uncertain = true;
			this.failure =
				"Bridge member cleanup is uncertain; membership and bridge authority are quarantined pending inspection";
			throw new Error(
				"Live or uncertain bridge members cannot release membership",
			);
		}
		this.members.delete(key);
	}
	private serialized<T>(
		timeoutMs: number,
		signal: AbortSignal | undefined,
		operation: (remaining: () => number) => Promise<T>,
	) {
		const remaining = budget(timeoutMs);
		const pending = this.observing.then(() => {
			signal?.throwIfAborted();
			remaining();
			return operation(remaining);
		});
		this.observing = pending.then(
			() => {},
			() => {},
		);
		return pending;
	}
	attachment(timeoutMs: number, signal?: AbortSignal) {
		return this.serialized(timeoutMs, signal, async (remaining) => {
			if (this.closing || this.cleanupFailed)
				throw new Error("Original bridge is closing or uncertain");
			if ([...this.members.values()].some((member) => member.pending))
				throw new Error(
					"Bridge membership is changing; no diagnostic authority during creation",
				);
			const observed = await this.observe(remaining(), signal);
			if (this.closing || this.cleanupFailed)
				throw new Error("Original bridge closed during observation");
			if (!observed) throw new Error("Created Compose network disappeared");
			this.owned(observed);
			if ([...this.members.values()].some((member) => member.pending))
				throw new Error(
					"Bridge membership changed during observation; no diagnostic authority during creation",
				);
			const expected = new Set(
				[...this.members.values()].flatMap((member) =>
					[...member.children]
						.map((child) => child.networkCreationIdentity(observed.id))
						.filter((id) => id !== null),
				),
			);
			if (observed.attachments.some((id) => !expected.has(id)))
				throw new Error(
					"Bridge contains an attachment without an original live creation receipt; no diagnostic or join authority",
				);
			return { id: observed.id };
		});
	}
	async memberAttachment(key: symbol, timeoutMs: number, signal?: AbortSignal) {
		if (!this.members.has(key))
			throw new Error("Bridge membership was released");
		const attachment = await this.attachment(timeoutMs, signal);
		if (!this.members.has(key) || this.closing || this.cleanupFailed)
			throw new Error("Original bridge membership closed during observation");
		return attachment;
	}
	/** The owning stack closes admission before any asynchronous cleanup. */
	closeAdmission() {
		this.closing = true;
	}
	stop() {
		this.closeAdmission();
		return this.serialized(10000, undefined, (remaining) =>
			this.stopOriginal(remaining),
		);
	}
	private async stopOriginal(remaining: () => number) {
		if (!this.mayHaveCreated) return;
		try {
			if (this.members.size)
				throw new Error(
					"Original bridge still has native members; dependent cleanup must settle first",
				);
			const existing = await this.observe(remaining());
			if (!existing) {
				this.mayHaveCreated = false;
				return;
			}
			this.owned(existing);
			if (existing.attachments.length)
				throw new Error(
					"Compose network still has attached resources; refusing forced removal or disconnect",
				);
			await this.commands.checked(["network", "rm", existing.id], {
				timeoutMs: remaining(),
				machine: true,
				effect: true,
			});
			if (await this.observe(remaining()))
				throw new Error("Compose network removal could not be confirmed");
			this.mayHaveCreated = false;
		} catch (error) {
			this.uncertain = true;
			this.failure =
				error instanceof Error
					? error.message
					: "Compose network cleanup is uncertain";
			throw error;
		}
	}
}

/** A live in-memory attachment claim. It cannot remove the underlying bridge. */
class ComposeNetworkMember {
	constructor(
		private root: ComposeNetwork,
		private key: symbol,
	) {}
	get cleanupFailed() {
		return this.root.cleanupFailed;
	}
	get runtimeStatus() {
		return this.root.runtimeStatus;
	}
	get logs() {
		return this.root.logs;
	}
	attachment(timeoutMs: number, signal?: AbortSignal) {
		return this.root.memberAttachment(this.key, timeoutMs, signal);
	}
	begin(child: ContainerProcess) {
		return this.root.begin(this.key, child);
	}
	release() {
		this.root.release(this.key);
	}
}
