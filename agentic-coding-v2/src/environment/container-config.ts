import { isIP } from "node:net";
import path from "node:path";
import { text as configurationText, object } from "../config.ts";

function text(value: unknown, label: string, max: number) {
	const result = configurationText(value, label, max);
	if (result.includes("\0")) throw new Error(`Invalid ${label}`);
	return result;
}
export type ContainerTarget = {
	socket: string;
	image: string;
	name?: string;
	command: string[];
	entrypoint?: string;
	ports: {
		host: number;
		container: number;
		protocol: "tcp" | "udp";
		address: string;
	}[];
	mounts: { source: string; target: string; readOnly: boolean }[];
	readiness: "running" | "healthy";
	/** A run target expected to terminate on its own; readiness becomes its exit. */
	completion?: boolean;
	dockerfile: string;
	context: string;
	buildArgs: string[];
	/** Declared container health command. This configures the engine's own check;
	 * it is not evidence that health was observed. */
	health?: {
		command: string;
		interval: string;
		timeout: string;
		retries: number;
		startPeriod: string | undefined;
	};
};
function keys(data: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(data).some((key) => !allowed.includes(key)))
		throw new Error("Unsupported container configuration field");
}
function strings(raw: unknown, label: string): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > 100)
		throw new Error(`Invalid ${label}`);
	return raw.map((value) => text(value, label, 4096));
}
function relative(raw: unknown, label: string, fallback: string) {
	const value = text(raw ?? fallback, label, 4096);
	if (path.isAbsolute(value) || value.split(/[\\/]/).includes(".."))
		throw new Error(`${label} must be a contained workspace-relative path`);
	return value;
}
function port(raw: unknown) {
	if (!Number.isSafeInteger(raw) || Number(raw) < 1 || Number(raw) > 65535)
		throw new Error("Invalid container port");
	return Number(raw);
}
export function readLocalSocket(raw: unknown) {
	const socket = text(raw, "container socket", 4096);
	if (!path.isAbsolute(socket) || /[\r\n]/.test(socket))
		throw new Error(
			"An explicit absolute local container API socket is required; implicit or remote daemon contexts are not used",
		);
	return socket;
}
/** A declared engine health command. Durations must be explicit engine units;
 * nothing here asserts that the engine ever reports a health transition. */
export function readHealth(raw: unknown): ContainerTarget["health"] {
	if (raw === undefined) return undefined;
	const value = object(raw);
	keys(value, ["command", "interval", "timeout", "retries", "startPeriod"]);
	const command = text(value.command, "container health command", 512);
	if (!command.trim() || /[\0\r\n]/.test(command))
		throw new Error(
			"Container health command must be one unbroken command line",
		);
	const duration = (key: string, fallback: string) => {
		const selected = value[key] ?? fallback;
		if (
			typeof selected !== "string" ||
			!/^\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(selected)
		)
			throw new Error(
				"Container health durations require explicit engine units such as 500ms, 30s or 2m",
			);
		return selected;
	};
	const retries = value.retries ?? 3;
	if (
		!Number.isSafeInteger(retries) ||
		Number(retries) < 1 ||
		Number(retries) > 100
	)
		throw new Error("Container health retries must be 1–100");
	return {
		command,
		interval: duration("interval", "30s"),
		timeout: duration("timeout", "30s"),
		retries: Number(retries),
		startPeriod:
			value.startPeriod === undefined
				? undefined
				: duration("startPeriod", "0s"),
	};
}
export function readContainer(raw: unknown): ContainerTarget {
	const data = object(raw);
	keys(data, [
		"socket",
		"image",
		"name",
		"command",
		"entrypoint",
		"ports",
		"mounts",
		"readiness",
		"dockerfile",
		"context",
		"buildArgs",
		"health",
		"completion",
	]);
	const socket = readLocalSocket(data.socket);
	const image = text(data.image, "container image", 512);
	if (image.startsWith("-") || /\s/.test(image))
		throw new Error("Invalid container image");
	const name =
		data.name === undefined
			? undefined
			: text(data.name, "container name", 100);
	if (name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
		throw new Error("Invalid container name");
	const buildArgs = strings(data.buildArgs, "container build argument");
	if (buildArgs.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
		throw new Error(
			"Build arguments must name explicitly declared environment variables, not literal secret values",
		);
	const ports = data.ports ?? [],
		mounts = data.mounts ?? [];
	if (
		!Array.isArray(ports) ||
		ports.length > 64 ||
		!Array.isArray(mounts) ||
		mounts.length > 64
	)
		throw new Error("Invalid container ports/mounts");
	const health = readHealth(data.health);
	if (data.completion !== undefined && typeof data.completion !== "boolean")
		throw new Error("Container completion must be a boolean");
	const readiness = data.readiness ?? "running";
	if (readiness !== "running" && readiness !== "healthy")
		throw new Error("Invalid container readiness");
	return {
		socket,
		image,
		...(name === undefined ? {} : { name }),
		command: strings(data.command, "container argument"),
		...(data.entrypoint === undefined
			? {}
			: { entrypoint: text(data.entrypoint, "container entrypoint", 4096) }),
		buildArgs,
		...(health ? { health } : {}),
		...(data.completion === true ? { completion: true } : {}),
		readiness,
		dockerfile: relative(data.dockerfile, "Dockerfile", "Dockerfile"),
		context: relative(data.context, "build context", "."),
		ports: ports.map((raw) => {
			const p = object(raw);
			keys(p, ["host", "container", "protocol", "address"]);
			const address = text(
				p.address ?? "127.0.0.1",
				"container publish address",
				100,
			);
			if (!isIP(address))
				throw new Error(
					"Container publish address must be an explicit IP address",
				);
			const protocol = p.protocol ?? "tcp";
			if (protocol !== "tcp" && protocol !== "udp")
				throw new Error("Invalid container port protocol");
			return {
				host: port(p.host),
				container: port(p.container),
				protocol,
				address,
			};
		}),
		mounts: mounts.map((raw) => {
			const m = object(raw);
			keys(m, ["source", "target", "readOnly"]);
			const source = relative(m.source, "container mount source", ".");
			const target = text(m.target, "container mount destination", 4096);
			if (
				!target.startsWith("/") ||
				source.includes(",") ||
				target.includes(",") ||
				/[\r\n]/.test(source + target)
			)
				throw new Error("Invalid bind mount path");
			if (m.readOnly !== undefined && typeof m.readOnly !== "boolean")
				throw new Error("Invalid bind mount readOnly");
			return { source, target, readOnly: m.readOnly !== false };
		}),
	};
}
