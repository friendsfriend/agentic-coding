import fs from "node:fs";
import path from "node:path";
import { digest, object, text } from "../config.ts";
import { contained } from "../git.ts";
import type { Plan } from "./catalog.ts";
import {
	type ContainerTarget,
	readContainer,
	readLocalSocket,
} from "./container-config.ts";

export type ComposeDefinition = {
	file: string;
	provider: "docker" | "podman";
	socket: string;
};
export type ComposePlan = {
	digest: string;
	services: {
		id: string;
		container: ContainerTarget;
		environment: Record<string, string>;
	}[];
};
function keys(value: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error(
			"Unsupported Compose field; this adapter refuses unsupported effects rather than guessing",
		);
}
export function readCompose(raw: unknown): ComposeDefinition {
	const data = object(raw);
	keys(data, ["file", "provider", "socket"]);
	if (data.provider !== "docker" && data.provider !== "podman")
		throw new Error("Compose needs an explicit Docker or Podman provider");
	const file = text(data.file, "Compose file", 4096);
	if (
		path.isAbsolute(file) ||
		file.includes("\0") ||
		file.split(/[\\/]/).includes("..")
	)
		throw new Error("Compose file must be workspace-relative");
	return {
		file,
		provider: data.provider,
		socket: readLocalSocket(data.socket),
	};
}
function source(workspace: string, definition: ComposeDefinition) {
	const file = contained(workspace, definition.file);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 65536)
			throw new Error("Compose file must be a regular file of at most 64 KiB");
		const buffer = Buffer.alloc(65537);
		let size = 0;
		while (size < buffer.length) {
			const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > 65536) throw new Error("Compose file exceeds 64 KiB");
		const bytes = buffer.subarray(0, size);
		return {
			file,
			contentDigest: digest(bytes.toString("base64")),
			source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		};
	} finally {
		fs.closeSync(fd);
	}
}
export function compileCompose(
	workspace: string,
	definition: ComposeDefinition,
): ComposePlan {
	const input = source(workspace, definition);
	if (input.source.includes("${"))
		throw new Error(
			"Compose interpolation is unsupported; declare literals or target secretRefs explicitly",
		);
	let document: Record<string, unknown>;
	try {
		document = object(Bun.YAML.parse(input.source));
	} catch {
		throw new Error("Invalid Compose YAML; source values are not logged");
	}
	keys(document, ["services"]);
	const services = Object.entries(object(document.services));
	if (!services.length || services.length > 16)
		throw new Error("Compose requires 1–16 services");
	const relative = (value: unknown) => {
		const selected = text(value, "Compose bind source", 4096);
		if (path.isAbsolute(selected) || selected.includes("\0"))
			throw new Error("Compose bind source must be workspace-relative");
		return path.relative(
			workspace,
			contained(
				workspace,
				path.join(path.relative(workspace, path.dirname(input.file)), selected),
			),
		);
	};
	return {
		digest: input.contentDigest,
		services: services.map(([id, raw]) => {
			if (!/^[a-z][a-z0-9-]{0,62}$/.test(id))
				throw new Error("Invalid Compose service identifier");
			const service = object(raw);
			keys(service, [
				"image",
				"command",
				"entrypoint",
				"environment",
				"ports",
				"volumes",
			]);
			const environment = Object.fromEntries(
				Object.entries(object(service.environment ?? {})).map(
					([key, value]) => {
						if (
							!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
							["WORKSPACE", "CONFIG_DIR"].includes(key) ||
							typeof value !== "string" ||
							value.includes("\0") ||
							value.length > 16000
						)
							throw new Error(
								"Compose environment requires explicit public string literals",
							);
						return [key, value];
					},
				),
			);
			const volumes = service.volumes ?? [];
			if (!Array.isArray(volumes) || volumes.length > 64)
				throw new Error("Invalid Compose bind mounts");
			const ports = service.ports ?? [];
			if (!Array.isArray(ports) || ports.length > 64)
				throw new Error("Invalid Compose ports");
			const container = readContainer({
				socket: definition.socket,
				image: service.image,
				command: service.command,
				entrypoint: service.entrypoint,
				ports: ports.map((raw) => {
					const port = object(raw);
					keys(port, ["target", "published", "host_ip", "protocol"]);
					return {
						container: port.target,
						host: port.published,
						address: port.host_ip ?? "127.0.0.1",
						protocol: port.protocol ?? "tcp",
					};
				}),
				mounts: volumes.map((raw) => {
					const mount = object(raw);
					keys(mount, ["type", "source", "target", "read_only"]);
					if (mount.type !== "bind")
						throw new Error(
							"Only contained Compose bind mounts are supported; named/external volumes are refused",
						);
					return {
						source: relative(mount.source),
						target: mount.target,
						readOnly: mount.read_only ?? true,
					};
				}),
				readiness: "running",
			});
			return { id, container, environment };
		}),
	};
}
export function verifyCompose(plan: Plan) {
	if (
		!plan.compose ||
		!plan.composePlan ||
		source(plan.workspace, plan.compose).contentDigest !==
			plan.composePlan.digest
	)
		throw new Error(
			"Compose source changed after approval; obtain a new exact plan approval",
		);
}
export function containerPlans(plan: Plan): Plan[] {
	const definition = plan.compose;
	if (!definition) return [plan];
	if (!plan.composePlan) throw new Error("Compose plan has not been compiled");
	return plan.composePlan.services.map((service) => ({
		...plan,
		compose: undefined,
		composePlan: undefined,
		runtime: definition.provider,
		app: `${plan.app}-${service.id}`,
		container: service.container,
		environment: { ...plan.environment, ...service.environment },
	}));
}
