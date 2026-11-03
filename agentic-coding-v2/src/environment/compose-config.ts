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
	network: "shared" | "isolated";
};
type Dependency = {
	id: string;
	condition: "service_started" | "service_healthy";
};
export type ComposePlan = {
	digest: string;
	services: {
		id: string;
		container: ContainerTarget;
		environment: Record<string, string>;
		dependsOn: Dependency[];
	}[];
};
function keys(value: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error(
			"Unsupported Compose field; this adapter refuses unsupported effects rather than guessing",
		);
}
function dependencies(raw: unknown): Dependency[] {
	const entries = Array.isArray(raw)
		? raw.map((id) => [id, { condition: "service_started" }] as const)
		: Object.entries(object(raw ?? {}));
	if (entries.length > 16) throw new Error("Too many Compose dependencies");
	const result = entries.map<Dependency>(([id, value]) => {
		if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(id))
			throw new Error("Invalid Compose dependency identifier");
		const settings = object(value);
		keys(settings, ["condition"]);
		const condition = settings.condition ?? "service_started";
		if (condition !== "service_started" && condition !== "service_healthy")
			throw new Error("Unsupported Compose dependency condition");
		return { id, condition };
	});
	if (new Set(result.map((value) => value.id)).size !== result.length)
		throw new Error("Duplicate Compose dependency");
	return result;
}
function orderServices(
	services: ComposePlan["services"],
): ComposePlan["services"] {
	const byId = new Map(services.map((service) => [service.id, service])),
		active = new Set<string>(),
		done = new Set<string>(),
		ordered: ComposePlan["services"] = [];
	const visit = (id: string) => {
		if (done.has(id)) return;
		if (active.has(id)) throw new Error("Compose dependency cycle");
		const service = byId.get(id);
		if (!service)
			throw new Error("Compose dependency references an unknown service");
		active.add(id);
		for (const dependency of service.dependsOn) {
			visit(dependency.id);
			if (dependency.condition === "service_healthy") {
				const prerequisite = byId.get(dependency.id);
				if (!prerequisite) throw new Error("Missing Compose prerequisite");
				prerequisite.container.readiness = "healthy";
			}
		}
		active.delete(id);
		done.add(id);
		ordered.push(service);
	};
	for (const service of services) visit(service.id);
	return ordered;
}
export function readCompose(raw: unknown): ComposeDefinition {
	const data = object(raw);
	keys(data, ["file", "provider", "socket", "network"]);
	if (
		data.network !== undefined &&
		data.network !== "shared" &&
		data.network !== "isolated"
	)
		throw new Error("Compose network must be shared or explicitly isolated");
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
		network: data.network ?? "shared",
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
		services: orderServices(
			services.map(([id, raw]) => {
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
					"depends_on",
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
				return {
					id,
					container,
					environment,
					dependsOn: dependencies(service.depends_on),
				};
			}),
		),
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
