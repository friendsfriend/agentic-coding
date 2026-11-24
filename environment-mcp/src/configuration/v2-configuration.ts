import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { type Executable, executableSchema } from "../domain/execution.ts";
import { captureHelmChart, readHelmSpec } from "./helm-chart.ts";
import {
	type KubernetesCluster,
	loadKubernetesClusters,
} from "./kubernetes-cluster.ts";
import { networkName } from "./network-name.ts";
import { action, identifier, runtime } from "./primitives.ts";
import { readConfigurationJson } from "./read-json.ts";
import type { ServerManifest } from "./server-manifest.ts";
import { dockerServiceBindingSchema } from "./service-binding.ts";

const projectSchema = z.object({
	id: identifier,
	kind: z.enum(["app", "library", "infrastructure"]).default("app"),
	repository: z.string().min(1).max(4096),
	defaults: z.record(z.string(), identifier).default({}),
	targets: z.array(z.record(z.string(), z.unknown())).max(256),
});
const environmentSchema = z.object({
	version: z.literal(1),
	projects: z.array(projectSchema).max(64),
	serviceBindings: z.record(z.string(), dockerServiceBindingSchema).optional(),
});
const configSchema = z.object({ repositories: z.array(z.string()).max(64) });

const strings = (value: unknown) =>
	z.record(z.string(), z.string().max(16000)).parse(value ?? {});

/** Read the v2 `environments.json` structure (plus adjacent `config.json` for
 * repositories) and normalize it into the standalone execution model. This is
 * a data reader, not the v2 agent/host configuration loader. */
export function readV2Configuration(
	configDir: string,
	repositoryOverride?: readonly string[],
): ServerManifest {
	const root = path.resolve(configDir);
	const rawConfig = repositoryOverride?.length
		? { repositories: [...repositoryOverride] }
		: configSchema.parse(readConfigurationJson(path.join(root, "config.json")));
	const environments = environmentSchema.parse(
		readConfigurationJson(path.join(root, "environments.json")),
	);
	const repositories = [
		...new Set(
			rawConfig.repositories.map((repository) => {
				const canonical = fs.realpathSync(repository);
				if (
					!path.isAbsolute(repository) ||
					!fs.statSync(canonical).isDirectory()
				)
					throw new Error("Invalid repository");
				return canonical;
			}),
		),
	];
	const bindings = environments.serviceBindings ?? {};
	const services = Object.entries(bindings).map(([id, binding]) => ({
		id,
		runtime: "docker" as const,
		binding,
	}));
	const clusters = loadKubernetesClusters(root, repositories);
	const networkTargets = new Set<string>();
	for (const project of environments.projects)
		for (const target of project.targets) {
			const compose = target.compose as { networkOnly?: unknown } | undefined;
			if (compose?.networkOnly === true)
				networkTargets.add(`${project.id}\0${String(target.id)}`);
		}
	const apps = environments.projects.map((project) => {
		const repository = fs.realpathSync(project.repository);
		if (!repositories.includes(repository))
			throw new Error("Unauthorized repository");
		return {
			id: project.id,
			repository,
			kind: project.kind,
			defaults: Object.fromEntries(
				Object.entries(project.defaults).filter(([key]) =>
					["build", "test", "run"].includes(key),
				),
			),
			targets: project.targets.map((target) => {
				try {
					return normalizeTarget(
						project.id,
						repository,
						target,
						clusters,
						networkTargets,
					);
				} catch (error) {
					// Unsupported execution descriptors stay visible but cannot be
					// admitted; one legacy target must not block the whole catalog.
					return {
						id: identifier.parse(target.id),
						action: action.parse(target.action),
						runtime: runtime.parse(target.runtime),
						profile: profileOf(target),
						dependsOn: [],
						prerequisites: [],
						endpoints: {},
						endpointServices: {},
						executionIssue: targetIssue(error),
					};
				}
			}),
		};
	});
	return { version: 1, repositories, services, apps };
}

function normalizeTarget(
	appId: string,
	repository: string,
	raw: Record<string, unknown>,
	clusters: ReadonlyMap<string, KubernetesCluster>,
	networkTargets: ReadonlySet<string>,
) {
	let endpoints: Record<string, string> = {};
	let endpointServices: Record<string, string> = {};
	const id = identifier.parse(raw.id);
	const act = action.parse(raw.action);
	const rt = runtime.parse(raw.runtime);
	const timeoutSec = Math.max(
		1,
		Math.min(7200, Math.ceil(Number(raw.timeoutMs ?? 30_000) / 1000)),
	);
	const requires = Array.isArray(raw.requires) ? raw.requires : [];
	const prerequisites = z
		.array(
			z.strictObject({
				app: identifier,
				target: identifier,
			}),
		)
		.max(16)
		.parse(raw.prerequisites ?? []);
	if (prerequisites.length && act !== "run")
		throw new Error("Prerequisites belong only to run targets");
	const dependsOn = requires.map((entry) => {
		const requirement = z
			.object({
				app: identifier.optional(),
				infra: identifier.optional(),
				lifecycle: z.enum(["shared", "external", "owned"]).optional(),
			})
			.refine((value) => Boolean(value.app) !== Boolean(value.infra))
			.parse(entry);
		const service = requirement.app ?? requirement.infra;
		if (!service) throw new Error("Invalid dependency");
		return { service, lifecycle: requirement.lifecycle ?? "shared" };
	});
	let executable: Executable | undefined;
	if (rt === "shell" || rt === "systemshell") {
		const command = typeof raw.command === "string" ? raw.command : undefined;
		if (command?.trim()) {
			const env = strings(raw.environment);
			const envRefs = strings(raw.secretRefs);
			if (act === "run") {
				const telemetry =
					raw.telemetry === undefined
						? undefined
						: z
								.strictObject({
									protocol: z.literal("otlp-http-json"),
									listen: z.literal("127.0.0.1:0"),
								})
								.parse(raw.telemetry);
				executable = executableSchema.parse({
					kind: "process",
					program: "/bin/sh",
					args: ["-lc", command],
					env,
					envRefs,
					...(typeof raw.readyText === "string"
						? { readyText: raw.readyText }
						: {}),
					...(typeof raw.readyUrl === "string"
						? { readyUrl: raw.readyUrl }
						: {}),
					...(telemetry ? { telemetry: "otlp-http-json" as const } : {}),
					timeoutSec,
				});
			} else {
				if (raw.readyText !== undefined || raw.readyUrl !== undefined)
					throw new Error("Readiness belongs to a run target");
				executable = executableSchema.parse({
					kind: "command",
					program: "/bin/sh",
					args: ["-lc", command],
					env,
					envRefs,
					timeoutSec,
				});
			}
		}
	} else if (
		(rt === "docker" || rt === "podman") &&
		act === "run" &&
		raw.container &&
		typeof raw.container === "object"
	) {
		const container = z
			.strictObject({
				socket: z.string().min(1).max(4096),
				image: z.string().min(1).max(512),
				name: z.string().min(1).max(128).optional(),
				ports: z
					.array(
						z.strictObject({
							host: z.number().int().min(1).max(65535),
							container: z.number().int().min(1).max(65535),
							address: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
						}),
					)
					.max(16)
					.default([]),
				environment: z.record(z.string(), z.string().max(16000)).default({}),
				readiness: z.enum(["running", "healthy"]).default("running"),
			})
			.parse(raw.container);
		const telemetry =
			raw.telemetry === undefined
				? undefined
				: z
						.strictObject({
							protocol: z.literal("otlp-http-json"),
							listen: z.literal("0.0.0.0:0"),
						})
						.parse(raw.telemetry);
		const name =
			container.name ??
			`environment-mcp-${appId}-${id}`
				.slice(0, 120)
				.replace(/[^a-z0-9_.-]+/g, "-");
		if (!/^environment-mcp-[a-z0-9][a-z0-9_.-]{0,120}$/.test(name))
			throw new Error("Container names must use the environment-mcp- prefix");
		executable = executableSchema.parse({
			kind: "container-run",
			provider: rt,
			socket: container.socket,
			image: container.image,
			name,
			ports: container.ports,
			env: container.environment,
			envRefs: strings(raw.secretRefs),
			readiness: container.readiness,
			...(telemetry ? { telemetry: "otlp-http-json" as const } : {}),
			timeoutSec,
		});
	} else if (
		(rt === "docker" || rt === "podman") &&
		act === "build" &&
		raw.container &&
		typeof raw.container === "object"
	) {
		const container = z
			.object({
				image: z.string().min(1).max(512),
				socket: z.string().min(1).max(4096),
				dockerfileSource: z.string().min(1).max(65536).optional(),
				dockerfile: z.string().min(1).max(4096).optional(),
			})
			.parse(raw.container);
		if ((rt === "docker" || rt === "podman") && container.dockerfileSource) {
			const buildSecrets = z
				.record(
					z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
					z.object({
						template: z.string().min(1).max(32768).optional(),
						encoding: z.enum(["xml", "text"]).default("text"),
						refs: z.record(z.string(), z.string()).default({}),
						file: z.string().min(1).max(4096).optional(),
						env: z
							.string()
							.regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
							.optional(),
					}),
				)
				.parse(
					(raw.container as { buildSecrets?: unknown }).buildSecrets ?? {},
				);
			executable = executableSchema.parse({
				kind: "docker-build",
				provider: rt,
				socket: container.socket,
				context: repository,
				dockerfileSource: container.dockerfileSource,
				image: container.image,
				secrets: Object.entries(buildSecrets).map(([secretId, secret]) => {
					const modes = [secret.template, secret.file, secret.env].filter(
						Boolean,
					).length;
					if (modes !== 1) throw new Error("Unsupported build secret");
					if (secret.template)
						return {
							kind: "template" as const,
							id: secretId,
							template: secret.template,
							encoding: secret.encoding,
							refs: secret.refs,
						};
					if (secret.env)
						return {
							kind: "env" as const,
							id: secretId,
							env: secret.env,
						};
					if (
						!secret.file ||
						!path.isAbsolute(secret.file) ||
						/[\0\r\n]/.test(secret.file)
					)
						throw new Error("Invalid build secret file");
					return {
						kind: "file" as const,
						id: secretId,
						file: secret.file,
					};
				}),
				timeoutSec,
			});
		} else if (rt === "docker" && container.dockerfile) {
			executable = executableSchema.parse({
				kind: "docker-build",
				provider: rt,
				socket: container.socket,
				context: repository,
				dockerfile: path.resolve(repository, container.dockerfile),
				image: container.image,
				timeoutSec,
			});
		}
	} else if (rt === "kubernetes" && act === "run" && raw.kubernetes) {
		const kubernetes = z
			.strictObject({
				cluster: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				namespace: z.string().min(1).max(63),
				workload: z.literal("helm-release-v1").optional(),
				helm: z.record(z.string(), z.unknown()),
			})
			.parse(raw.kubernetes);
		if (
			raw.endpoints !== undefined ||
			raw.endpointServices !== undefined ||
			raw.readyText !== undefined ||
			raw.readyUrl !== undefined
		)
			throw new Error(
				"Helm targets do not support endpoint, text or URL readiness declarations",
			);
		const cluster = clusters.get(kubernetes.cluster);
		if (!cluster) throw new Error("Kubernetes cluster is not configured");
		const helm = readHelmSpec(kubernetes.helm);
		const capture = captureHelmChart(repository, helm);
		executable = executableSchema.parse({
			kind: "helm-release",
			cluster: cluster.id,
			clusterDigest: cluster.digest,
			namespace: kubernetes.namespace,
			release: helm.release,
			chart: capture.root,
			chartDigest: capture.digest,
			values: capture.values,
			setString: helm.setString,
			timeoutSec,
		});
	} else if (
		rt === "compose" &&
		act === "run" &&
		raw.compose &&
		typeof raw.compose === "object" &&
		(raw.compose as { networkOnly?: unknown }).networkOnly === true
	) {
		const compose = z
			.object({
				file: z.string().min(1).max(4096),
				source: z.string().min(1).max(65536).optional(),
				provider: z.string().optional(),
				socket: z.string().min(1).max(4096),
				network: z.literal("shared").optional(),
				networkOnly: z.literal(true),
			})
			.parse(raw.compose);
		const source = compose.source
			? compose.source
			: fs.readFileSync(path.resolve(repository, compose.file), "utf8");
		const parsed = z
			.object({
				name: z.string().optional(),
				services: z.record(z.string(), z.unknown()).default({}),
			})
			.parse(Bun.YAML.parse(source));
		if (
			Object.keys(parsed.services).length ||
			raw.endpoints !== undefined ||
			raw.endpointServices !== undefined ||
			raw.telemetry !== undefined ||
			raw.secretRefs !== undefined
		)
			throw new Error(
				"Network-only Compose targets require exactly empty services and no secret, telemetry or endpoint declarations",
			);
		executable = executableSchema.parse({
			kind: "network-only",
			provider: compose.provider ?? "docker",
			socket: compose.socket,
			network: networkName(appId, id),
			app: appId,
			target: id,
			timeoutSec,
		});
	} else if (rt === "compose" && act === "run" && raw.compose) {
		const compose = z
			.object({
				file: z.string().min(1).max(4096),
				source: z.string().min(1).max(65536).optional(),
				provider: z.string().optional(),
				socket: z.string().min(1).max(4096),
				envRefs: z.record(z.string(), z.string()).optional(),
				networkFrom: z
					.strictObject({
						app: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
						target: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
					})
					.optional(),
			})
			.parse(raw.compose);
		const source = compose.source
			? compose.source
			: fs.readFileSync(path.resolve(repository, compose.file), "utf8");
		const parsed = z
			.object({
				name: z.string().optional(),
				services: z.record(z.string(), z.unknown()),
			})
			.parse(Bun.YAML.parse(source));
		const serviceIds = Object.keys(parsed.services);
		if (!serviceIds.length || serviceIds.length > 16)
			throw new Error("Unsupported Compose service count");
		const containerRefKey = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
		const referenceName = /^[A-Z_][A-Z0-9_]{0,127}$/;
		const serviceRefs: Record<string, Record<string, string>> = {};
		for (const [serviceId, definition] of Object.entries(parsed.services)) {
			if (!definition || typeof definition !== "object") continue;
			const service = definition as {
				environment?: unknown;
				"x-secret-refs"?: unknown;
			};
			const rawRefs = service["x-secret-refs"];
			if (rawRefs === undefined) continue;
			const refs = z
				.record(
					z.string().regex(containerRefKey),
					z.string().regex(referenceName),
				)
				.parse(rawRefs);
			const literal = new Set(literalEnvironmentKeys(service.environment));
			for (const key of Object.keys(refs))
				if (literal.has(key))
					throw new Error(
						"Compose service secret reference conflicts with literal environment",
					);
			serviceRefs[serviceId] = refs;
		}
		const targetRefs = z
			.record(
				z.string().regex(containerRefKey),
				z.string().regex(referenceName),
			)
			.parse(raw.secretRefs ?? {});
		const telemetry =
			raw.telemetry === undefined
				? undefined
				: z
						.strictObject({
							protocol: z.literal("otlp-http-json"),
							listen: z.literal("0.0.0.0:0"),
							collectorService: z.string().regex(containerRefKey),
							transport: z.literal("tls-host-gateway-v1"),
						})
						.parse(raw.telemetry);
		if (telemetry) {
			const collector = parsed.services[telemetry.collectorService] as
				| Record<string, unknown>
				| undefined;
			const command = collector?.command;
			const extraHosts = collector?.extra_hosts;
			const collectorEnvironment = literalEnvironmentKeys(
				collector?.environment,
			);
			const reservedSecrets = Object.keys(targetRefs).some(
				(key) => key.startsWith("OTEL_") || key.startsWith("AC_OTEL_"),
			);
			const volumes = Array.isArray(collector?.volumes)
				? collector.volumes
				: [];
			const reservedMount = volumes.some((volume) => {
				if (typeof volume === "string") return volume.includes("otel-ca.pem");
				if (!volume || typeof volume !== "object") return false;
				const target = (volume as { target?: unknown }).target;
				return (
					typeof target === "string" &&
					(target === "/" ||
						target === "/environment-mcp-otel-ca.pem" ||
						target.startsWith("/environment-mcp-otel-ca.pem/"))
				);
			});
			const hostGateway =
				(Array.isArray(extraHosts) &&
					extraHosts.includes("host.docker.internal:host-gateway")) ||
				(Boolean(extraHosts) &&
					typeof extraHosts === "object" &&
					(extraHosts as Record<string, unknown>)["host.docker.internal"] ===
						"host-gateway");
			if (!collector)
				throw new Error(
					"Compose telemetry requires its exact unexposed collector service and host gateway",
				);
			if (
				collector.image !== "otel/opentelemetry-collector-contrib:0.162.0" ||
				JSON.stringify(command) !==
					JSON.stringify(["--config=env:OTEL_COLLECTOR_CONFIG"]) ||
				collector.entrypoint !== undefined ||
				(Array.isArray(collector.ports) && collector.ports.length > 0) ||
				!hostGateway ||
				collectorEnvironment.some(
					(key) => key.startsWith("OTEL_") || key.startsWith("AC_OTEL_"),
				) ||
				collector["x-secret-refs"] !== undefined ||
				reservedSecrets ||
				reservedMount
			)
				throw new Error(
					"Compose telemetry requires its exact unexposed collector service and host gateway",
				);
		}
		const serviceEnvRefs: Record<string, Record<string, string>> = {};
		for (const serviceId of serviceIds) {
			const literal = new Set(
				literalEnvironmentKeys(
					(parsed.services[serviceId] as { environment?: unknown } | undefined)
						?.environment,
				),
			);
			const selected = { ...targetRefs };
			for (const [key, reference] of Object.entries(
				serviceRefs[serviceId] ?? {},
			)) {
				if (selected[key] && selected[key] !== reference)
					throw new Error("Conflicting Compose secret references");
				if (literal.has(key))
					throw new Error(
						"Compose service secret reference conflicts with literal environment",
					);
				selected[key] = reference;
			}
			for (const key of Object.keys(selected))
				if (literal.has(key))
					throw new Error(
						"Compose service secret reference conflicts with literal environment",
					);
			if (Object.keys(selected).length) serviceEnvRefs[serviceId] = selected;
		}
		for (const definition of Object.values(parsed.services)) {
			if (!definition || typeof definition !== "object") continue;
			const name = (definition as { container_name?: unknown }).container_name;
			if (
				name !== undefined &&
				(typeof name !== "string" ||
					!/^environment-mcp-[a-z0-9][a-z0-9_.-]{0,120}$/.test(name))
			)
				throw new Error("Container names must use the environment-mcp- prefix");
		}
		endpoints = readEndpoints(raw.endpoints);
		endpointServices = readEndpointServices(
			raw.endpointServices,
			endpoints,
			serviceIds,
		);
		if (
			compose.networkFrom &&
			!networkTargets.has(
				`${compose.networkFrom.app}\0${compose.networkFrom.target}`,
			)
		)
			throw new Error(
				"Compose networkFrom must name a configured network-only target",
			);
		// All MCP-owned Compose workloads share one named group.
		const project = "environment-mcp";
		executable = executableSchema.parse({
			kind: "compose",
			provider: compose.provider ?? "docker",
			socket: compose.socket,
			...(compose.source
				? { source: compose.source }
				: { file: path.resolve(repository, compose.file) }),
			project,
			services: serviceIds,
			envRefs: strings(compose.envRefs),
			serviceEnvRefs,
			...(compose.networkFrom
				? {
						networkFrom: {
							...compose.networkFrom,
							network: networkName(
								compose.networkFrom.app,
								compose.networkFrom.target,
							),
						},
					}
				: {}),
			...(telemetry
				? {
						telemetry: {
							protocol: telemetry.protocol,
							collectorService: telemetry.collectorService,
							transport: telemetry.transport,
						},
					}
				: {}),
			timeoutSec,
		});
	}
	return {
		id,
		action: act,
		runtime: rt,
		profile: profileOf(raw),
		dependsOn,
		prerequisites,
		endpoints: executable?.kind === "compose" ? endpoints : {},
		endpointServices: executable?.kind === "compose" ? endpointServices : {},
		...(executable ? { executable } : { executionIssue: unsupportedIssue(rt) }),
	};
}

function unsupportedIssue(runtime: string) {
	if (runtime === "kubernetes") return "kubernetes-unsupported";
	if (runtime === "podman") return "podman-unsupported";
	if (runtime === "compose") return "compose-invalid";
	if (runtime === "shell" || runtime === "systemshell")
		return "missing-command";
	return "docker-target-unsupported";
}

function targetIssue(error: unknown) {
	const message = error instanceof Error ? error.message : "";
	if (
		message.includes("Kubernetes") ||
		message.includes("Helm") ||
		message.includes("chart") ||
		message.includes("cluster")
	)
		return "kubernetes-invalid";
	if (
		message.includes("environment-mcp- prefix") ||
		message.toLowerCase().includes("prefix")
	)
		return "container-name-prefix";
	if (message.includes("Compose service count")) return "compose-service-count";
	if (message.includes("endpoint") || message.includes("Endpoint"))
		return "endpoint-invalid";
	if (message.includes("Build secret") || message.includes("build secret"))
		return "build-secret-invalid";
	if (message.includes("Readiness") || message.includes("readiness"))
		return "readiness-invalid";
	if (message.includes("Compose") || message.includes("compose"))
		return "compose-invalid";
	return "unsupported-descriptor";
}

function literalEnvironmentKeys(raw: unknown) {
	const keys = new Set<string>();
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (typeof entry !== "string") continue;
			const separator = entry.indexOf("=");
			if (separator > 0) keys.add(entry.slice(0, separator));
		}
	} else if (raw && typeof raw === "object") {
		for (const key of Object.keys(raw)) keys.add(key);
	}
	return [...keys];
}

function readEndpoints(raw: unknown) {
	const endpoints = z
		.record(identifier, z.string().min(1).max(4096))
		.parse(raw ?? {});
	for (const [name, value] of Object.entries(endpoints)) {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!["127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error(`Invalid loopback endpoint: ${name}`);
	}
	return endpoints;
}

function readEndpointServices(
	raw: unknown,
	endpoints: Record<string, string>,
	services: readonly string[],
) {
	const selectors = z.record(identifier, identifier).parse(raw ?? {});
	const names = Object.keys(endpoints);
	if (
		Object.keys(selectors).length !== names.length ||
		names.some((name) => !Object.hasOwn(selectors, name)) ||
		Object.values(selectors).some((service) => !services.includes(service))
	)
		throw new Error("Every endpoint requires one Compose service selector");
	return selectors;
}

function profileOf(raw: Record<string, unknown>) {
	return typeof raw.profile === "string" && raw.profile.length <= 64
		? raw.profile
		: undefined;
}
