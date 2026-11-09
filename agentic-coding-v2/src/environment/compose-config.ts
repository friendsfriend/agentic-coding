import fs from "node:fs";
import path from "node:path";
import { digest, object, text } from "../config.ts";
import { contained } from "../git.ts";
import {
	readContainer,
	readHealth,
	readLocalSocket,
} from "./container-config.ts";
import type {
	ComposeDefinition,
	ComposePlan,
	ComposeDependency as Dependency,
	Plan,
	Target,
} from "./model.ts";

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
		if (
			condition !== "service_started" &&
			condition !== "service_healthy" &&
			condition !== "service_completed_successfully"
		)
			throw new Error("Unsupported Compose dependency condition");
		return { id, condition };
	});
	if (new Set(result.map((value) => value.id)).size !== result.length)
		throw new Error("Duplicate Compose dependency");
	return result;
}
/** Exec-form health argv is shell-quoted word by word, never evaluated as source. */
function shellWord(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function sharedMemory(raw: unknown) {
	if (raw === undefined) return undefined;
	if (typeof raw === "number") return raw;
	if (typeof raw !== "string")
		throw new Error("Invalid Compose shared memory size");
	const match = /^(\d+)([bkmg])?$/i.exec(raw);
	if (!match) throw new Error("Invalid Compose shared memory size");
	return (
		Number(match[1]) *
		({ b: 1, k: 1024, m: 1048576, g: 1073741824 }[
			match[2]?.toLowerCase() ?? "b"
		] ?? 1)
	);
}
function hosts(raw: unknown) {
	if (!Array.isArray(raw)) return raw;
	const pairs = raw.map((entry) => {
		if (typeof entry !== "string")
			throw new Error("Invalid Compose host mapping");
		const match = /^([^=:]+)[=:](.+)$/.exec(entry);
		if (!match) throw new Error("Invalid Compose host mapping");
		return [match[1], match[2]] as const;
	});
	if (new Set(pairs.map(([host]) => host)).size !== pairs.length)
		throw new Error("Duplicate Compose host mapping");
	return Object.fromEntries(pairs);
}
function serviceSecrets(raw: unknown) {
	const refs = object(raw ?? {});
	if (Object.keys(refs).length > 100)
		throw new Error("Too many service secret references");
	return Object.fromEntries(
		Object.entries(refs).map(([key, ref]) => {
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
				["WORKSPACE", "CONFIG_DIR", "PATH", "HOME"].includes(key) ||
				typeof ref !== "string" ||
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)
			)
				throw new Error("Invalid service secret reference");
			return [key, ref];
		}),
	);
}
function healthcheck(raw: unknown) {
	if (raw === undefined) return undefined;
	const value = object(raw);
	keys(value, [
		"test",
		"interval",
		"timeout",
		"retries",
		"start_period",
		"disable",
	]);
	if (value.disable === true) {
		if (Object.keys(value).length > 1)
			throw new Error(
				"Compose healthcheck disable cannot be combined with other settings",
			);
		return undefined;
	}
	if (value.disable !== undefined && value.disable !== false)
		throw new Error("Compose healthcheck disable must be a boolean");
	const test = value.test;
	if (test === undefined)
		throw new Error("Compose healthcheck requires a test");
	let command: string;
	if (typeof test === "string") command = test;
	else if (Array.isArray(test)) {
		const [kind, ...rest] = test;
		if (
			kind === "CMD" &&
			rest.length > 0 &&
			rest.every(
				(word) =>
					typeof word === "string" && word.length > 0 && !/[\0\r\n]/.test(word),
			)
		) {
			command = `exec ${rest.map((word) => shellWord(String(word))).join(" ")}`;
		} else {
			if (
				kind !== "CMD-SHELL" ||
				rest.length !== 1 ||
				typeof rest[0] !== "string"
			)
				throw new Error(
					"Compose healthcheck requires a string, [CMD-SHELL, command], or non-empty bounded CMD argv",
				);
			command = rest[0];
		}
	} else throw new Error("Invalid Compose healthcheck test");
	const duration = (key: string) => {
		const selected = value[key];
		if (selected === undefined) return undefined;
		if (typeof selected !== "string")
			throw new Error("Compose healthcheck durations must be strings");
		const match = /^(\d+(?:\.\d+)?(?:ms|s|m|h))+$/.exec(selected);
		if (!match) throw new Error("Invalid Compose healthcheck duration");
		return selected;
	};
	return readHealth({
		command,
		...(duration("interval") ? { interval: duration("interval") } : {}),
		...(duration("timeout") ? { timeout: duration("timeout") } : {}),
		...(value.retries === undefined ? {} : { retries: value.retries }),
		...(duration("start_period")
			? { startPeriod: duration("start_period") }
			: {}),
	});
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
			const prerequisite = byId.get(dependency.id);
			if (dependency.condition === "service_healthy") {
				if (!prerequisite) throw new Error("Missing Compose prerequisite");
				prerequisite.container.readiness = "healthy";
			}
			// A completion prerequisite must terminate successfully before its
			// dependent starts; it has no long-lived readiness of its own.
			if (dependency.condition === "service_completed_successfully") {
				if (!prerequisite) throw new Error("Missing Compose prerequisite");
				prerequisite.container.completion = true;
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
/** One declared environment file. Values are literal and only read on a live
 * approval path: captured offline inspection cannot honour them. */
function readEnvFile(
	workspace: string,
	raw: unknown,
	live: boolean,
	auxiliary?: Record<string, string>,
): { values: Record<string, string>; digest: string; file: string } {
	const selected = Array.isArray(raw)
		? raw.length === 1 && typeof raw[0] === "string"
			? raw[0]
			: undefined
		: raw;
	if (typeof selected !== "string")
		throw new Error(
			"Compose env_file requires exactly one declared relative path",
		);
	const parts = selected.split("/");
	if (
		!selected ||
		selected.length > 200 ||
		parts.length > 3 ||
		parts.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(part))
	)
		throw new Error(
			"Compose env_file requires a bounded relative public path with no dotfiles",
		);
	const defined = auxiliary?.[selected];
	if (defined === undefined && !live)
		throw new Error(
			"Compose env_file requires a staged auxiliary source or an approval-time read; offline inspection will not guess",
		);
	if (defined !== undefined)
		return {
			...parseEnvFile(Buffer.from(defined, "utf8"), selected),
			file: selected,
		};
	const file = contained(workspace, selected),
		fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 65536)
			throw new Error(
				"Compose env_file must be a regular file of at most 64 KiB",
			);
		const buffer = Buffer.alloc(65537);
		let size = 0;
		while (size < buffer.length) {
			const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > 65536) throw new Error("Compose env_file exceeds 64 KiB");
		return {
			...parseEnvFile(buffer.subarray(0, size), path.relative(workspace, file)),
			file: path.relative(workspace, file),
		};
	} finally {
		fs.closeSync(fd);
	}
}
/** One declared environment file body, from staged bytes or a live read. */
function parseEnvFile(bytes: Buffer, name: string) {
	if (bytes.length > 65536) throw new Error("Compose env_file exceeds 64 KiB");
	const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		values: Record<string, string> = {};
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const split = trimmed.indexOf("=");
		if (split < 1) throw new Error("Compose env_file lines require KEY=value");
		const key = trimmed.slice(0, split),
			value = trimmed.slice(split + 1);
		if (
			!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
			["WORKSPACE", "CONFIG_DIR"].includes(key) ||
			value.includes("\0") ||
			value.length > 16000
		)
			throw new Error(
				"Compose env_file entries must be plain public values of bounded length",
			);
		if (values[key] !== undefined)
			throw new Error("Compose env_file must not repeat a key");
		values[key] = value;
	}
	return { values, digest: digest(bytes.toString("base64")), name };
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
	return compileComposeSource(
		workspace,
		definition,
		source(workspace, definition),
		true,
	);
}
/** Parse already captured source without reopening it. This creates data only,
 * never an approved plan or authority to contact an engine. */
export function compileComposeSource(
	workspace: string,
	definition: ComposeDefinition,
	input: { source: string; contentDigest: string },
	readEnvFiles = false,
	auxiliary?: Record<string, string>,
): ComposePlan {
	const file = contained(workspace, definition.file);
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
				path.join(path.relative(workspace, path.dirname(file)), selected),
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
					"healthcheck",
					"restart",
					"env_file",
					"x-secret-refs",
					"shm_size",
					"extra_hosts",
				]);
				const envFile =
					service.env_file === undefined
						? undefined
						: readEnvFile(workspace, service.env_file, readEnvFiles, auxiliary);
				// env_file values are the base; an explicit literal in the service
				// environment wins, and neither may take over the runtime's own paths.
				const environment = Object.fromEntries(
					Object.entries({
						...(envFile?.values ?? {}),
						...object(service.environment ?? {}),
					}).map(([key, value]) => {
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
					}),
				);
				const secretRefs = serviceSecrets(service["x-secret-refs"]);
				if (Object.keys(secretRefs).some((key) => key in environment))
					throw new Error(
						"Service environment cannot override a secret reference",
					);
				const volumes = service.volumes ?? [];
				if (!Array.isArray(volumes) || volumes.length > 64)
					throw new Error("Invalid Compose bind mounts");
				const ports = service.ports ?? [];
				if (!Array.isArray(ports) || ports.length > 64)
					throw new Error("Invalid Compose ports");
				// Only the default no-restart policy is equivalent to this adapter's
				// one-creation lifetime; anything else would invent a restart owner.
				if (service.restart !== undefined && service.restart !== "no")
					throw new Error(
						"Unsupported Compose restart policy; declare restart: no or omit it",
					);
				const serviceHealth = healthcheck(service.healthcheck);
				const container = readContainer({
					socket: definition.socket,
					shmSize: sharedMemory(service.shm_size),
					extraHosts: hosts(service.extra_hosts),
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
					...(serviceHealth ? { health: serviceHealth } : {}),
				});
				return {
					id,
					container,
					environment,
					...(Object.keys(secretRefs).length ? { secretRefs } : {}),
					...(envFile
						? { envFile: envFile.file, envFileDigest: envFile.digest }
						: {}),
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
	// A declared environment file is bound to the approval by its own digest.
	for (const service of plan.composePlan.services) {
		if (!service.envFile || !service.envFileDigest) continue;
		if (
			readEnvFile(plan.workspace, service.envFile, true).digest !==
			service.envFileDigest
		)
			throw new Error(
				"Compose env_file changed after approval; obtain a new exact plan approval",
			);
	}
}
/** Freeze explicit diagnostics onto one service before approval. Neither service
 * order nor a matching port may choose a service or a completion prerequisite. */
export function bindComposeDiagnostics(
	target: Target,
	plan: ComposePlan,
): ComposePlan {
	for (const service of plan.services)
		if (
			Object.entries(service.secretRefs ?? {}).some(
				([key, ref]) =>
					key in target.environment ||
					(key in target.secretRefs && target.secretRefs[key] !== ref),
			)
		)
			throw new Error(
				"Service secret reference conflicts with target environment",
			);
	const selected = new Set<string>();
	const bind = (id: string | undefined, host: string, port: number) => {
		const service = plan.services.find((entry) => entry.id === id);
		if (
			!service ||
			service.container.completion ||
			!service.container.ports.some(
				(binding) =>
					binding.address === host &&
					binding.host === port &&
					binding.protocol === "tcp",
			)
		)
			throw new Error(
				"Compose diagnostics require an explicit non-completion service with an exact declared TCP loopback publication",
			);
		selected.add(service.id);
	};
	for (const [name, value] of Object.entries(target.endpoints ?? {})) {
		const url = new URL(value);
		bind(
			target.endpointServices?.[name],
			url.hostname.replace(/^\[|\]$/g, ""),
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		);
	}
	if (target.queryConnection)
		bind(
			target.queryService,
			target.queryConnection.host,
			target.queryConnection.port,
		);
	return {
		...plan,
		services: plan.services.map((service) =>
			selected.has(service.id)
				? {
						...service,
						container: { ...service.container, readiness: "healthy" },
					}
				: service,
		),
	};
}
export function containerPlans(plan: Plan): Plan[] {
	const definition = plan.compose;
	if (!definition) return [plan];
	if (!plan.composePlan) throw new Error("Compose plan has not been compiled");
	return plan.composePlan.services.map((service) => ({
		...plan,
		compose: undefined,
		composePlan: undefined,
		endpointServices: undefined,
		queryService: undefined,
		endpoints: Object.fromEntries(
			Object.entries(plan.endpoints ?? {}).filter(
				([name]) => plan.endpointServices?.[name] === service.id,
			),
		),
		endpointCaRefs: Object.fromEntries(
			Object.entries(plan.endpointCaRefs ?? {}).filter(
				([name]) => plan.endpointServices?.[name] === service.id,
			),
		),
		endpointAuthRefs: Object.fromEntries(
			Object.entries(plan.endpointAuthRefs ?? {}).filter(
				([name]) => plan.endpointServices?.[name] === service.id,
			),
		),
		queryConnection:
			plan.queryService === service.id ? plan.queryConnection : undefined,
		runtime: definition.provider,
		app: `${plan.app}-${service.id}`,
		container: service.container,
		environment: { ...plan.environment, ...service.environment },
		secretRefs: { ...plan.secretRefs, ...service.secretRefs },
	}));
}
