import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, object } from "../config.ts";
import { EnvironmentCommands } from "./command.ts";
import type { Plan } from "./model.ts";
import type { processEnvironment } from "./shell.ts";

export type VolumeReceipt = {
	name: string;
	createdAt: string;
	nonce: string;
	host: string;
	scope: string;
};
export type PlannedVolume = {
	id: string;
	scope: string;
	lifetime: "persistent" | "ephemeral";
	/** The exact locally recorded creation receipt presented for fresh approval. */
	receipt?: VolumeReceipt;
};
const hostLabel = "dev.agentic-coding.v2.host";
const scopeLabel = "dev.agentic-coding.v2.volume-scope";
const nonceLabel = "dev.agentic-coding.v2.volume-nonce";
function location(stateDir: string, socket: string, scope: string) {
	let canonical: string;
	try {
		canonical = fs.realpathSync(socket);
	} catch {
		canonical = path.resolve(socket);
	}
	return path.join(
		stateDir,
		"environment-volumes",
		digest(JSON.stringify([canonical, scope])),
	);
}
function readReceipt(file: string): VolumeReceipt | undefined {
	let fd: number;
	try {
		fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
			throw new Error("Invalid persistent volume receipt");
		const bytes = Buffer.alloc(4097);
		const size = fs.readSync(fd, bytes, 0, bytes.length, null);
		if (size > 4096) throw new Error("Invalid persistent volume receipt");
		const value = object(JSON.parse(bytes.subarray(0, size).toString("utf8")));
		if (
			Object.keys(value).sort().join(",") !==
				"createdAt,host,name,nonce,scope" ||
			typeof value.name !== "string" ||
			!/^acv2-volume-[a-f0-9]{32}$/.test(value.name) ||
			typeof value.createdAt !== "string" ||
			!Number.isFinite(Date.parse(value.createdAt)) ||
			typeof value.nonce !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.nonce) ||
			typeof value.host !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.host) ||
			typeof value.scope !== "string" ||
			value.scope.length > 200
		)
			throw new Error("Invalid persistent volume receipt");
		return value as VolumeReceipt;
	} finally {
		fs.closeSync(fd);
	}
}
/** Local metadata only. No engine probe or attachment is authorized by this read. */
export function prepareVolumes(plan: Plan, stateDir: string): Plan {
	const socket = plan.compose?.socket;
	if (!socket || !plan.composePlan?.volumes?.length) return plan;
	return {
		...plan,
		composePlan: {
			...plan.composePlan,
			volumes: plan.composePlan.volumes.map((declared) => {
				const volume = {
					...declared,
					scope: declared.scope.startsWith("@app/")
						? `${plan.app}:${declared.id}`
						: declared.scope,
				};
				const receipt =
					volume.lifetime === "persistent"
						? readReceipt(`${location(stateDir, socket, volume.scope)}.json`)
						: undefined;
				if (
					receipt &&
					(receipt.host !== digest(stateDir) || receipt.scope !== volume.scope)
				)
					throw new Error(
						"Persistent volume receipt belongs to a different host or scope",
					);
				return { ...volume, ...(receipt ? { receipt } : {}) };
			}),
		},
	};
}
/** Volumes have no immutable engine IDs. A fresh approved stored creation receipt,
 * random name+nonce, exact CreatedAt, local driver/scope and an exclusive native
 * lock are all required for reuse. Labels or a discovered name alone never suffice.
 * Persistent data is never deleted by lifecycle cleanup, including failed starts. */
export class ComposeVolumes {
	private commands: EnvironmentCommands;
	private entries: {
		volume: PlannedVolume;
		file: string;
		receipt: VolumeReceipt;
		created: boolean;
	}[] = [];
	private locks: string[] = [];
	private failed = false;
	private pendingCreation = false;
	constructor(
		private plan: Plan,
		private stateDir: string,
		configDir: string,
		environment: ReturnType<typeof processEnvironment>,
	) {
		const definition = plan.compose;
		if (!definition) throw new Error("Missing volume provider");
		this.commands = new EnvironmentCommands(
			plan,
			configDir,
			definition.provider,
			[
				definition.provider === "docker" ? "--host" : "--url",
				definition.provider === "docker"
					? `unix://${definition.socket}`
					: pathToFileURL(definition.socket).href.replace(/^file:/, "unix:"),
			],
			environment,
		);
	}
	get cleanupFailed() {
		return (
			this.failed ||
			this.pendingCreation ||
			this.commands.cleanupFailed ||
			this.commands.uncertainEffect
		);
	}
	get logs() {
		return this.commands.logs;
	}
	private async inspect(name: string, timeoutMs: number, signal?: AbortSignal) {
		const listed = (
			await this.commands.checked(
				["volume", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"],
				{ timeoutMs, signal, machine: true },
			)
		)
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (
			listed.length > 100 ||
			listed.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))
		)
			throw new Error("Invalid volume listing; absence unconfirmed");
		if (!listed.includes(name)) return undefined;
		const raw: unknown = JSON.parse(
			await this.commands.checked(["volume", "inspect", name], {
				timeoutMs,
				signal,
				machine: true,
			}),
		);
		if (!Array.isArray(raw) || raw.length !== 1)
			throw new Error("Invalid volume observation");
		const value = object(raw[0]),
			labels = object(value.Labels ?? {});
		if (
			value.Name !== name ||
			value.Driver !== "local" ||
			value.Scope !== "local" ||
			typeof value.CreatedAt !== "string" ||
			!Number.isFinite(Date.parse(value.CreatedAt)) ||
			Object.keys(object(value.Options ?? {})).length ||
			typeof labels[nonceLabel] !== "string"
		)
			throw new Error(
				"Volume identity, local driver or creation time unavailable",
			);
		return {
			name,
			createdAt: value.CreatedAt,
			nonce: String(labels[nonceLabel]),
			host: String(labels[hostLabel]),
			scope: String(labels[scopeLabel]),
		};
	}
	private same(left: VolumeReceipt, right: VolumeReceipt) {
		return JSON.stringify(left) === JSON.stringify(right);
	}
	async start(timeoutMs: number, signal: AbortSignal) {
		const deadline = Date.now() + timeoutMs;
		const budget = () => {
			signal.throwIfAborted();
			const left = deadline - Date.now();
			if (left <= 0) throw new Error("Volume operation timed out");
			return left;
		};
		const socket = this.plan.compose?.socket;
		if (!socket) throw new Error("Missing volume socket");
		for (const volume of this.plan.composePlan?.volumes ?? []) {
			budget();
			const base = location(this.stateDir, socket, volume.scope);
			fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
			// A crash leaves this lock quarantined. No PID/age/labels-based takeover.
			fs.mkdirSync(`${base}.lock`, { mode: 0o700 });
			this.locks.push(`${base}.lock`);
			const current =
				volume.lifetime === "persistent"
					? readReceipt(`${base}.json`)
					: undefined;
			if (JSON.stringify(current) !== JSON.stringify(volume.receipt))
				throw new Error(
					"Volume receipt changed after approval; fresh approval required",
				);
			if (current) {
				const observed = await this.inspect(current.name, budget(), signal);
				if (!observed || !this.same(current, observed))
					throw new Error(
						"Approved persistent volume is absent or replaced; no adoption or recreation",
					);
				this.entries.push({
					volume,
					file: `${base}.json`,
					receipt: current,
					created: false,
				});
				continue;
			}
			const name = `acv2-volume-${randomBytes(16).toString("hex")}`,
				nonce = randomBytes(32).toString("hex"),
				host = digest(this.stateDir);
			if (await this.inspect(name, budget(), signal))
				throw new Error("New volume name occupied; no adoption");
			this.pendingCreation = true;
			const returned = (
				await this.commands.checked(
					[
						"volume",
						"create",
						"--driver",
						"local",
						"--label",
						`${hostLabel}=${host}`,
						"--label",
						`${scopeLabel}=${volume.scope}`,
						"--label",
						`${nonceLabel}=${nonce}`,
						name,
					],
					{ timeoutMs: budget(), signal, machine: true, effect: true },
				)
			).trim();
			if (returned !== name) {
				this.failed = true;
				throw new Error("Lost volume creation receipt; inspection required");
			}
			const receipt = await this.inspect(name, budget(), signal);
			if (
				!receipt ||
				receipt.host !== host ||
				receipt.scope !== volume.scope ||
				receipt.nonce !== nonce
			) {
				this.failed = true;
				throw new Error("Volume creation identity could not be verified");
			}
			this.entries.push({
				volume,
				file: `${base}.json`,
				receipt,
				created: true,
			});
			if (volume.lifetime === "persistent") {
				try {
					const fd = fs.openSync(
						`${base}.json`,
						fs.constants.O_WRONLY |
							fs.constants.O_CREAT |
							fs.constants.O_EXCL |
							fs.constants.O_NOFOLLOW,
						0o600,
					);
					try {
						fs.writeFileSync(fd, JSON.stringify(receipt));
						fs.fsyncSync(fd);
					} finally {
						fs.closeSync(fd);
					}
				} catch {
					this.failed = true;
					throw new Error(
						"Persistent volume receipt could not be durably recorded; data retained for inspection",
					);
				}
			}
			this.pendingCreation = false;
		}
	}
	async attachment(id: string, timeoutMs: number, signal: AbortSignal) {
		const entry = this.entries.find((entry) => entry.volume.id === id);
		if (!entry)
			throw new Error("Volume lacks a live approved attachment receipt");
		const observed = await this.inspect(entry.receipt.name, timeoutMs, signal);
		if (!observed || !this.same(entry.receipt, observed)) {
			this.failed = true;
			throw new Error(
				"Volume changed before attachment; refusing name-only reuse",
			);
		}
		return entry.receipt.name;
	}
	async verify(timeoutMs: number, signal: AbortSignal) {
		const deadline = Date.now() + timeoutMs;
		for (const entry of this.entries) {
			const left = deadline - Date.now();
			if (left <= 0) throw new Error("Volume observation timed out");
			await this.attachment(entry.volume.id, left, signal);
		}
	}
	async stop() {
		if (this.cleanupFailed)
			throw new Error(
				"Volume creation or cleanup uncertain; locks retained for inspection",
			);
		try {
			for (const entry of [...this.entries].reverse()) {
				const observed = await this.inspect(entry.receipt.name, 10000);
				if (!observed || !this.same(entry.receipt, observed))
					throw new Error("Volume identity changed; retained for inspection");
				if (entry.volume.lifetime === "ephemeral" && entry.created) {
					await this.commands.checked(["volume", "rm", entry.receipt.name], {
						timeoutMs: 10000,
						machine: true,
						effect: true,
					});
					if (await this.inspect(entry.receipt.name, 10000))
						throw new Error("Volume removal unconfirmed");
				}
			}
			for (const lock of this.locks.splice(0)) fs.rmdirSync(lock);
		} catch {
			this.failed = true;
			throw new Error(
				"Volume cleanup identity uncertain; locks and persistent data retained",
			);
		}
	}
}
