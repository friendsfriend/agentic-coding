// Offline, inert conversion only. Never executes discovery commands, imports v1
// runtime code, writes live configuration, reads credential values, or applies a plan.
import fs from "node:fs";
import path from "node:path";
import { digest, loadConfig, object } from "../src/config.ts";
import { validateProjects } from "../src/environment/catalog.ts";
import {
	compileCompose,
	compileComposeSource,
	readCompose,
} from "../src/environment/compose-config.ts";
import { checkComposeTelemetry } from "../src/environment/compose-telemetry.ts";
import {
	composeArgv,
	composeEnvironment,
} from "../src/environment/compose-values.ts";
import { definitionByteLimit } from "../src/environment/definition-limits.ts";
import {
	hostBuildDockerfile,
	hostBuildSourceDigest,
} from "../src/environment/host-build-spec.ts";
import { discoverRepositoryTargets } from "../src/environment/repository-targets.ts";
import {
	collectorTelemetry,
	legacyCollectorConfigDigest,
} from "../src/environment/telemetry-bridge-spec.ts";

class Refusal extends Error {}
function flag(name: string, required = true) {
	const args = process.argv.slice(2),
		at = args.indexOf(name),
		value = args[at + 1];
	if (at < 0 && !required) return undefined;
	if (at < 0 || !value || value.startsWith("--"))
		throw new Refusal(`Required option: ${name}`);
	return path.resolve(value);
}
const source = flag("--source-config"),
	current = flag("--current-config"),
	output = flag("--output"),
	socket = flag("--socket"),
	sourceTree = flag("--source-tree", false),
	npmrc = flag("--npmrc-reference", false),
	infrastructureRepository = flag("--infrastructure-repository", false);
if (!source || !current || !output || !socket)
	throw new Refusal("Explicit source/current/output directories required");
if (process.argv.includes("--apply"))
	throw new Refusal(
		"This command cannot apply; native exact-digest developer promotion is required",
	);
if (fs.existsSync(output))
	throw new Refusal("Preview output already exists; refusing overwrite");
const roots = [source, ...(sourceTree ? [sourceTree] : [])].map((root) =>
	fs.realpathSync(root),
);
const manifest = new Map<
	string,
	{ file: string; digest: string; bytes: number }
>();
function capture(relative: string) {
	const file = path.resolve(source ?? "", relative);
	if (
		path
			.relative(source ?? "", file)
			.split(path.sep)
			.includes("..")
	)
		throw new Refusal("Source path escapes the configured source root");
	let real: string;
	try {
		real = fs.realpathSync(file);
	} catch {
		throw new Refusal("Missing/broken source input");
	}
	if (!roots.some((root) => real.startsWith(`${root}${path.sep}`)))
		throw new Refusal(
			"Source symlink leaves explicitly authorized source roots; add its source-tree root explicitly",
		);
	const stat = fs.statSync(real);
	if (!stat.isFile() || stat.size > 65536)
		throw new Refusal("Source is not a bounded regular file");
	const bytes = fs.readFileSync(real);
	if (bytes.length > 65536) throw new Refusal("Source grew beyond its bound");
	manifest.set(relative, {
		file: relative,
		digest: digest(bytes),
		bytes: bytes.length,
	});
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
const loadedConfig = loadConfig(
	path.join(output, "unused-validation-state"),
	process.cwd(),
	current,
);
// An explicit preview repository is data-only authorization to propose a mapping,
// never authorization to modify the live repository allow-list or execute it.
const infrastructureRoot = infrastructureRepository
	? fs.realpathSync(infrastructureRepository)
	: undefined;
if (infrastructureRoot && !fs.statSync(infrastructureRoot).isDirectory())
	throw new Refusal("Infrastructure repository must be an existing directory");
const requiredRepositories =
	infrastructureRoot &&
	!loadedConfig.repositories.some(
		(repository) => fs.realpathSync(repository) === infrastructureRoot,
	)
		? [infrastructureRoot]
		: [];
const config = requiredRepositories.length
	? {
			...loadedConfig,
			repositories: [...loadedConfig.repositories, ...requiredRepositories],
		}
	: loadedConfig;
const base = fs.readFileSync(path.join(current, "environments.json"), "utf8");
if (Buffer.byteLength(base) > definitionByteLimit)
	throw new Refusal("Current definitions exceed bundle bounds");
let document: Record<string, unknown>;
try {
	document = object(JSON.parse(base));
} catch {
	throw new Refusal("Invalid current definition JSON; values withheld");
}
validateProjects(config, document);
const projects: (Record<string, unknown> & {
	targets: Record<string, unknown>[];
})[] = (document.projects as Record<string, unknown>[]).map((project) => ({
	...project,
	targets: [...(project.targets as Record<string, unknown>[])],
}));
const rows: {
	app: string;
	source: string;
	status: "candidate" | "blocked" | "already-present";
	reason?: string;
	target?: string;
	requiredReferences?: string[];
}[] = [];
const required = new Set<string>();
const safeId = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
const reference = (service: string, key: string) =>
	`V2_${service}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
function flatten(
	relative: string,
	visited = new Set<string>(),
	active = new Set<string>(),
) {
	if (active.has(relative)) throw new Refusal("Compose include cycle");
	if (visited.has(relative)) return { services: {}, volumes: {}, networks: {} };
	if (visited.size + active.size >= 32)
		throw new Refusal("Compose include closure exceeds 32 files");
	active.add(relative);
	let parsed: Record<string, unknown>;
	try {
		parsed = object(Bun.YAML.parse(capture(relative)));
	} catch (error) {
		if (error instanceof Refusal) throw error;
		throw new Refusal("Source YAML refused without logging values");
	}
	if (
		Object.keys(parsed).some(
			(key) =>
				!["include", "name", "services", "volumes", "networks"].includes(key),
		)
	)
		throw new Refusal("Unsupported top-level Compose effect");
	const merged: Record<
		"services" | "volumes" | "networks",
		Record<string, unknown>
	> = { services: {}, volumes: {}, networks: {} };
	const includes = parsed.include ?? [];
	if (!Array.isArray(includes))
		throw new Refusal("Compose includes must be explicit path arrays");
	for (const include of includes) {
		if (typeof include !== "string")
			throw new Refusal(
				"Complex Compose includes need an explicit native conversion",
			);
		const next = path.normalize(path.join(path.dirname(relative), include));
		const closure = flatten(next, visited, active);
		for (const section of ["services", "volumes", "networks"] as const)
			for (const [id, value] of Object.entries(closure[section])) {
				if (
					id in merged[section] &&
					JSON.stringify(merged[section][id]) !== JSON.stringify(value)
				)
					throw new Refusal("Conflicting included definitions");
				merged[section][id] = value;
			}
	}
	for (const section of ["services", "volumes", "networks"] as const)
		for (const [id, value] of Object.entries(object(parsed[section] ?? {}))) {
			if (id in merged[section])
				throw new Refusal(
					"Include overrides require explicit conversion rather than order-based guessing",
				);
			merged[section][id] =
				section === "volumes"
					? { ...object(value ?? {}), "x-scope": `migration:${relative}:${id}` }
					: value;
		}
	visited.add(relative);
	active.delete(relative);
	return merged;
}
function convertedCompose(relative: string) {
	const merged = flatten(relative);
	let telemetry: typeof collectorTelemetry | undefined;
	if (
		relative === "apps/compose/grid-allocation-backend-compose.yml" &&
		Object.hasOwn(merged.services, "otel-collector")
	) {
		const collector = object(merged.services["otel-collector"]),
			producer = object(merged.services["grid-allocation-backend"]),
			exporter = composeEnvironment(collector.environment),
			appEnvironment = composeEnvironment(producer.environment);
		if (
			typeof exporter.OTEL_COLLECTOR_CONFIG !== "string" ||
			digest(exporter.OTEL_COLLECTOR_CONFIG) !== legacyCollectorConfigDigest ||
			exporter.AC_OTEL_ENDPOINT !==
				`\${AC_OTEL_ENDPOINT:-http://host.docker.internal:4318}` ||
			Object.keys(exporter).sort().join() !==
				"AC_OTEL_ENDPOINT,OTEL_COLLECTOR_CONFIG" ||
			appEnvironment.OTEL_SERVICE_NAME !==
				`\${AC_OTEL_SERVICE_NAME:-grid-allocation-backend}` ||
			appEnvironment.OTEL_RESOURCE_ATTRIBUTES !==
				`\${AC_OTEL_RESOURCE_ATTRIBUTES:-ac.app=grid-allocation-backend}` ||
			appEnvironment.OTEL_EXPORTER_OTLP_ENDPOINT !==
				"http://otel-collector:4318" ||
			appEnvironment.OTEL_EXPORTER_OTLP_PROTOCOL !== "http/protobuf"
		)
			throw new Refusal(
				"Telemetry source changed; explicit collector/runtime binding conversion required",
			);
		collector.environment = {};
		producer.environment = {
			...appEnvironment,
			OTEL_SERVICE_NAME: "grid-allocation-backend",
			OTEL_RESOURCE_ATTRIBUTES: "ac.app=grid-allocation-backend",
		};
		telemetry = collectorTelemetry;
	}
	const refs = new Set<string>();
	for (const [id, raw] of Object.entries(merged.services)) {
		const service = object(raw),
			environment = composeEnvironment(service.environment),
			serviceRefs: Record<string, string> = {};
		for (const [key, value] of Object.entries(environment)) {
			if (typeof value !== "string")
				throw new Refusal(
					"Non-string Compose environment requires an explicit conversion",
				);
			const whole = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
			if (whole?.[1]) {
				required.add(whole[1]);
				serviceRefs[key] = whole[1];
				delete environment[key];
			} else if (value.includes("${"))
				throw new Refusal(
					"Embedded/default interpolation needs native runtime template/telemetry conversion; refusing to freeze a live receiver or credential into a literal",
				);
			else if (
				/(?:PASSWORD|SECRET|TOKEN|PRIVATEKEY|PUBLICKEY)/i.test(key) &&
				value
			) {
				serviceRefs[key] = reference(id, key);
				delete environment[key];
			}
		}
		const command = composeArgv(service.command);
		if (Array.isArray(command) && command.includes("--requirepass")) {
			const at = command.indexOf("--requirepass");
			if (
				command[0] !== "redis-server" ||
				!command.every((word) => typeof word === "string") ||
				command.filter((word) => word === "--requirepass").length !== 1 ||
				typeof command[at + 1] !== "string"
			)
				throw new Refusal(
					"Unknown command credential syntax; refusing to guess",
				);
			const existing = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(command[at + 1]);
			serviceRefs.ACV2_REDIS_PASSWORD =
				existing?.[1] ?? reference(id, "PASSWORD");
			const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
			service.command = [
				"/bin/sh",
				"-c",
				`exec ${command.map((word, index) => (index === at + 1 ? '"$ACV2_REDIS_PASSWORD"' : quote(String(word)))).join(" ")}`,
			];
		}
		const health = object(service.healthcheck ?? {});
		if (JSON.stringify(health).includes("-proot")) {
			if (
				JSON.stringify(health.test) !==
					JSON.stringify([
						"CMD",
						"mysqladmin",
						"ping",
						"-h",
						"localhost",
						"-uroot",
						"-proot",
					]) ||
				!serviceRefs.MYSQL_ROOT_PASSWORD
			)
				throw new Refusal(
					"Unknown health credential syntax; refusing to guess",
				);
			service.healthcheck = {
				...health,
				test: [
					"CMD-SHELL",
					'exec mysqladmin ping -h localhost -uroot "-p$MYSQL_ROOT_PASSWORD"',
				],
			};
		}
		service.environment = environment;
		if (Object.keys(serviceRefs).length) service["x-secret-refs"] = serviceRefs;
		for (const ref of Object.values(serviceRefs)) refs.add(ref);
	}
	return {
		source: Bun.YAML.stringify(merged),
		refs: [...refs].sort(),
		telemetry,
	};
}
function convertedBuild(relative: string) {
	let source = capture(relative);
	const buildSecrets: Record<string, unknown> = {},
		secretRefs: Record<string, string> = {};
	if (source.includes("source=settings.xml,target=settings.xml")) {
		const template = capture("templates/settings.xml");
		const names = [...template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)]
			.map((match) => match[1])
			.filter((name): name is string => Boolean(name));
		if (
			!names.length ||
			names.some(
				(name) =>
					!["ARTIFACTORY_USERNAME", "ARTIFACTORY_PASSWORD"].includes(name),
			)
		)
			throw new Refusal("Unknown Maven template references");
		for (const name of names) secretRefs[name] = name;
		buildSecrets.settings = {
			template,
			encoding: "xml",
			refs: Object.fromEntries(names.map((name) => [name, name])),
		};
		source = source
			.replaceAll(
				"--mount=type=bind,source=settings.xml,target=settings.xml",
				"--mount=type=secret,id=settings,target=/run/secrets/settings.xml,required=true",
			)
			.replaceAll("-s settings.xml", "-s /run/secrets/settings.xml");
	}
	if (source.includes("source=.npmrc,target=.npmrc")) {
		if (!npmrc)
			throw new Refusal(
				"Private npm builds require an explicit --npmrc-reference file path; credential bytes are never copied",
			);
		buildSecrets.npmrc = { file: npmrc };
		source = source.replaceAll(
			"--mount=type=bind,source=.npmrc,target=.npmrc",
			"--mount=type=secret,id=npmrc,target=/root/.npmrc,required=true",
		);
	}
	// Ensure every credential-consuming RUN mounts its input again: COPY . .
	// cannot bring credentials into later stages because none enter the context.
	const logical: string[] = [];
	let instruction = "";
	for (const line of source.split("\n")) {
		instruction += `${line}\n`;
		if (!line.endsWith("\\")) {
			logical.push(instruction);
			instruction = "";
		}
	}
	if (instruction) throw new Refusal("Unclosed Dockerfile continuation");
	source = logical
		.map((instruction) => {
			if (!/^RUN\s/i.test(instruction)) return instruction;
			const mounts = [
				buildSecrets.settings &&
				/\bmvn\b/.test(instruction) &&
				!instruction.includes("id=settings")
					? "--mount=type=secret,id=settings,target=/run/secrets/settings.xml,required=true"
					: "",
				buildSecrets.npmrc &&
				/\bnpm\s+(?:ci|install)\b/.test(instruction) &&
				!instruction.includes("id=npmrc")
					? "--mount=type=secret,id=npmrc,target=/root/.npmrc,required=true"
					: "",
			]
				.filter(Boolean)
				.join(" ");
			return mounts
				? instruction.replace(/^RUN\s/i, `RUN ${mounts} `)
				: instruction;
		})
		.join("");
	if (
		source.includes("source=settings.xml") ||
		source.includes("source=.npmrc")
	)
		throw new Refusal("Unconverted credential bind remains in Dockerfile");
	return { source, buildSecrets, secretRefs };
}
const infrastructureIds = [
	"redis",
	"postgres",
	"mailpit",
	"activemq",
	"azurite",
	"playwright-server",
] as const;
const infrastructureProjects = new Set<string>();
if (infrastructureRoot) {
	const targetId = "run-compose-default",
		topologyId = "host-infra-network";
	const bundle: typeof projects = [],
		refs = new Set<string>();
	try {
		const network = flatten("infrastructure/compose/network-compose.yml");
		if (
			Object.keys(network.services).length ||
			Object.keys(network.volumes).length ||
			Object.keys(network.networks).join() !== "devenv-local" ||
			JSON.stringify(object(network.networks["devenv-local"])) !==
				JSON.stringify({ driver: "bridge" })
		)
			throw new Refusal(
				"Global topology differs from the explicit single bridge; effects cannot be omitted",
			);
		bundle.push({
			id: topologyId,
			kind: "infrastructure",
			repository: infrastructureRoot,
			defaults: { run: targetId },
			targets: [
				{
					id: targetId,
					action: "run",
					runtime: "compose",
					profile: "default",
					compose: {
						file: "compose.native.yaml",
						source: "services: {}\n",
						provider: "docker",
						socket,
						network: "shared",
						networkOnly: true,
					},
				},
			],
		});
		for (const id of infrastructureIds) {
			const metadata = object(
				JSON.parse(capture(`infrastructure/definitions/${id}.json`)),
			);
			if (
				Object.keys(metadata).sort().join() !==
					"containerBaseName,displayName,ident" ||
				metadata.ident !== id ||
				typeof metadata.displayName !== "string" ||
				!metadata.displayName ||
				metadata.displayName.length > 200 ||
				typeof metadata.containerBaseName !== "string" ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(metadata.containerBaseName)
			)
				throw new Refusal(
					"Global infrastructure metadata differs from its explicit native mapping",
				);
			const converted = convertedCompose(
					`infrastructure/compose/${id}-compose.yml`,
				),
				parsed = object(Bun.YAML.parse(converted.source)),
				services = object(parsed.services);
			if (
				Object.keys(services).join() !== id ||
				object(services[id]).container_name !== metadata.containerBaseName ||
				JSON.stringify(parsed.networks) !== JSON.stringify(network.networks)
			)
				throw new Refusal(
					"Global service closure differs from its one declared service and exact bridge",
				);
			const compose = {
				file: "compose.native.yaml",
				source: converted.source,
				provider: "docker",
				socket,
				network: "shared",
				networkFrom: { app: topologyId, target: targetId },
			};
			const parsedNative = compileComposeSource(
				infrastructureRoot,
				readCompose(compose),
				{ source: converted.source, contentDigest: digest(converted.source) },
			);
			for (const service of parsedNative.services)
				for (const ref of Object.values(service.secretRefs ?? {}))
					refs.add(ref);
			bundle.push({
				id: `host-infra-${id}`,
				kind: "infrastructure",
				repository: infrastructureRoot,
				defaults: { run: targetId },
				targets: [
					{
						id: targetId,
						label: metadata.displayName,
						action: "run",
						runtime: "compose",
						profile: "default",
						prerequisites: [{ app: topologyId, target: targetId }],
						compose,
					},
				],
			});
		}
		if (
			bundle.some((project) =>
				projects.some((existing) => existing.id === project.id),
			)
		)
			throw new Refusal(
				"Global infrastructure IDs conflict with native definitions; no target or defaults are overwritten",
			);
		validateProjects(config, {
			version: 1,
			projects: [...projects, ...bundle],
		});
		projects.push(...bundle);
		for (const project of bundle) {
			infrastructureProjects.add(String(project.id));
			rows.push({
				app: String(project.id),
				source: `infrastructure/compose/${project.id === topologyId ? "network" : String(project.id).slice("host-infra-".length)}-compose.yml`,
				target: targetId,
				status: "candidate",
				reason:
					"Explicit frozen native infrastructure mapping: independent units on one original protected topology, exact reserved source container names and loopback publications; no existing-container adoption, legacy bridge/volume reuse or cross-owner borrowing",
			});
		}
		for (const ref of refs) required.add(ref);
	} catch (error) {
		for (const id of ["network", ...infrastructureIds])
			rows.push({
				app: `host-infra-${id}`,
				source: `infrastructure/compose/${id}-compose.yml`,
				status: "blocked",
				reason:
					error instanceof Refusal
						? error.message
						: "Global infrastructure conversion refused atomically; values withheld",
			});
	}
}
for (const project of projects) {
	const id = String(project.id),
		repository = String(project.repository);
	if (project.kind !== "app") continue;
	const candidates: {
		relative: string;
		action: "run" | "build";
		profile: string;
	}[] = [];
	const build = `apps/build/${id}-build.Dockerfile`;
	if (fs.existsSync(path.join(source, build)))
		candidates.push({ relative: build, action: "build", profile: "default" });
	else if (
		fs.existsSync(path.dirname(path.join(source, build))) &&
		fs
			.readdirSync(path.dirname(path.join(source, build)))
			.includes(`${id}-build.Dockerfile`)
	)
		rows.push({
			app: id,
			source: build,
			status: "blocked",
			reason: "Broken source symlink",
		});
	for (const name of fs
		.readdirSync(path.join(source, "apps", "compose"))
		.sort()) {
		if (name === `${id}-compose.yml`)
			candidates.push({
				relative: `apps/compose/${name}`,
				action: "run",
				profile: "default",
			});
		else if (name.startsWith(`${id}-`) && name.endsWith("-compose.yml"))
			candidates.push({
				relative: `apps/compose/${name}`,
				action: "run",
				profile: name.slice(id.length + 1, -"-compose.yml".length),
			});
	}
	for (const candidate of candidates) {
		const targetId = `${candidate.action}-${candidate.action === "run" ? "compose" : "docker"}-${safeId(candidate.profile)}`;
		try {
			if (
				candidates.filter(
					(entry) =>
						entry.action === candidate.action &&
						safeId(entry.profile) === safeId(candidate.profile),
				).length !== 1
			)
				throw new Refusal(
					"Distinct source profiles collide on a native target ID; no source is overwritten and explicit reconciliation is required",
				);
			let target: Record<string, unknown>, refs: string[];
			if (candidate.action === "run") {
				const converted = convertedCompose(candidate.relative);
				const definition = {
					file: "compose.captured.yaml",
					source: converted.source,
					provider: "docker",
					socket,
					network: "shared",
				};
				const composed = readCompose(definition);
				checkComposeTelemetry(
					{ telemetry: converted.telemetry, compose: composed },
					compileCompose(repository, composed),
				);
				target = {
					id: targetId,
					action: "run",
					runtime: "compose",
					profile: candidate.profile,
					timeoutMs: 180000,
					compose: definition,
					...(converted.telemetry ? { telemetry: converted.telemetry } : {}),
				};
				refs = converted.refs;
			} else {
				const converted = convertedBuild(candidate.relative);
				target = {
					id: targetId,
					action: "build",
					runtime: "docker",
					profile: candidate.profile,
					timeoutMs: 3600000,
					secretRefs: converted.secretRefs,
					container: {
						image: `devenv-${id}:latest`,
						socket,
						dockerfileSource: converted.source,
						buildSecrets: converted.buildSecrets,
					},
				};
				refs = Object.values(converted.secretRefs);
			}
			validateProjects(config, {
				version: 1,
				projects: [
					{
						...project,
						targets: [target],
						defaults: undefined,
						requires: undefined,
						prerequisites: undefined,
					},
				],
			});
			const old = project.targets.findIndex((entry) => entry.id === targetId);
			if (old >= 0) project.targets[old] = target;
			else project.targets.push(target);
			for (const ref of refs) required.add(ref);
			rows.push({
				app: id,
				source: candidate.relative,
				status: "candidate",
				target: targetId,
				requiredReferences: refs,
			});
		} catch (error) {
			rows.push({
				app: id,
				source: candidate.relative,
				status: "blocked",
				reason:
					error instanceof Refusal
						? error.message
						: "Native schema/compiler refused conversion; input values and exception text withheld",
			});
		}
	}
}
const repositoryDiscovery: {
	app: string;
	report?: ReturnType<typeof discoverRepositoryTargets>;
	reason?: string;
}[] = [];
for (const project of projects) {
	if (project.kind === "infrastructure") continue;
	const id = String(project.id),
		repository = String(project.repository);
	try {
		const report = discoverRepositoryTargets(
			config,
			repository,
			undefined,
			".",
			"v1",
		);
		repositoryDiscovery.push({ app: id, report });
		for (const hint of report.targets) {
			if (project.kind === "library" && hint.action === "run") continue;
			const targetId = `${hint.action}-shell-${hint.profile}`,
				target = {
					id: targetId,
					action: hint.action,
					runtime: "shell",
					profile: hint.profile,
					command: hint.invocation
						.map((part) => JSON.stringify(part))
						.join(" "),
					timeoutMs: hint.action === "run" ? 180000 : 3600000,
				};
			const old = project.targets.find((entry) => entry.id === targetId);
			if (old) {
				rows.push({
					app: id,
					source: `repository:${id}/${hint.source}`,
					target: targetId,
					status: "already-present",
					reason:
						"Existing native target ID retained; metadata is not overwrite authority",
				});
				continue;
			}
			validateProjects(config, {
				version: 1,
				projects: [
					{
						...project,
						targets: [target],
						defaults: undefined,
						requires: undefined,
						prerequisites: undefined,
					},
				],
			});
			project.targets.push(target);
			rows.push({
				app: id,
				source: `repository:${id}/${hint.source}`,
				target: targetId,
				status: "candidate",
				reason:
					hint.action === "run"
						? "Native process-start-only run; no service health, endpoint, credentials or prerequisites inferred"
						: "Native fixed tool invocation; repository code remains subject to exact execution review",
			});
		}
	} catch {
		repositoryDiscovery.push({
			app: id,
			reason:
				"Repository discovery unavailable or native metadata refused; values withheld",
		});
		rows.push({
			app: id,
			source: `repository:${id}`,
			status: "blocked",
			reason:
				"Authorized repository metadata unavailable or refused; no commands executed",
		});
	}
}
// The known dev-server script is self-contained shell code, not a legacy runtime
// wrapper. Its metadata becomes native readiness and explicit prerequisite edges.
const frontend = projects.find(
	(project) => project.id === "grid-allocation-frontend",
);
const frontendSource = "apps/run/grid-allocation-frontend-default.sh";
if (frontend && fs.existsSync(path.join(source, frontendSource))) {
	try {
		const script = capture(frontendSource);
		const ready = /^# devenv:ready=(.+)$/m.exec(script)?.[1]?.trim();
		const declaration = /^# devenv:requires=(.+)$/m.exec(script)?.[1];
		if (!ready || !declaration || script.length > 16000)
			throw new Refusal(
				"Dev-server source requires bounded native command bytes and explicit prerequisite/readiness metadata",
			);
		let edges: unknown;
		try {
			edges = JSON.parse(declaration);
		} catch {
			throw new Refusal("Invalid prerequisite metadata; values withheld");
		}
		if (!Array.isArray(edges) || !edges.length || edges.length > 16)
			throw new Refusal(
				"Dev-server prerequisite metadata exceeds the native graph bound",
			);
		const prerequisites = edges.map((value) => {
			const edge = object(value);
			if (
				Object.keys(edge).some(
					(key) => !["app", "runtime", "profile"].includes(key),
				) ||
				typeof edge.app !== "string" ||
				edge.runtime !== "docker" ||
				typeof edge.profile !== "string"
			)
				throw new Refusal(
					"Unknown dev-server prerequisite selection; not inferred",
				);
			const dependency = projects.find((project) => project.id === edge.app);
			const candidates =
				dependency?.targets.filter(
					(target) =>
						target.action === "run" &&
						(target.runtime === "docker" ||
							(target.runtime === "compose" &&
								object(target.compose).provider === "docker")) &&
						target.profile === edge.profile,
				) ?? [];
			const preferred = candidates.filter(
				(target) => target.id === object(dependency?.defaults ?? {}).run,
			);
			const selected = preferred.length === 1 ? preferred : candidates;
			if (selected.length !== 1 || typeof selected[0]?.id !== "string")
				throw new Refusal(
					"Declared backend run target is absent or ambiguous after conversion; frontend is not enabled without its prerequisite",
				);
			return { app: edge.app, target: selected[0].id };
		});
		const target = {
			id: "run-shell-default",
			action: "run",
			runtime: "shell",
			profile: "default",
			label: "Dev Server (vite + local backend)",
			command: script,
			readyUrl: ready,
			timeoutMs: 180000,
			endpoints: { web: ready },
			prerequisites,
		};
		if (Array.isArray(frontend.prerequisites) && frontend.prerequisites.length)
			throw new Refusal(
				"Existing project-level prerequisite selections require explicit reconciliation before target-scoped migration",
			);
		const systemId = "run-systemshell-default",
			existingSystem = frontend.targets.find((entry) => entry.id === systemId);
		const systemTarget = existingSystem ?? {
			...target,
			id: systemId,
			runtime: "systemshell",
		};
		const next = {
			...frontend,
			targets: [
				...frontend.targets.filter(
					(entry) => entry.id !== target.id && entry.id !== systemId,
				),
				target,
				systemTarget,
			],
		};
		validateProjects(config, {
			version: 1,
			projects: projects.map((project) =>
				project === frontend ? next : project,
			),
		});
		Object.assign(frontend, next);
		rows.push({
			app: String(frontend.id),
			source: frontendSource,
			status: "candidate",
			target: target.id,
		});
		rows.push({
			app: String(frontend.id),
			source: frontendSource,
			status: existingSystem ? "already-present" : "candidate",
			target: systemId,
			reason: existingSystem
				? "Existing native target ID retained without claiming source interpreter, command or prerequisite equivalence; reconcile differing overrides explicitly"
				: "v1 POSIX system-shell alternative uses sh from the approved PATH with the same captured bytes, target-pinned prerequisites and readiness; no tmux or legacy runtime delegation",
		});
	} catch (error) {
		rows.push({
			app: String(frontend.id),
			source: frontendSource,
			status: "blocked",
			reason:
				error instanceof Refusal
					? error.message
					: "Native dev-server conversion refused; source values withheld",
		});
	}
}
for (const directory of ["apps/build", "apps/run", "infrastructure/compose"]) {
	const absolute = path.join(source, directory);
	if (!fs.existsSync(absolute)) continue;
	for (const name of fs.readdirSync(absolute).sort()) {
		const relative = `${directory}/${name}`;
		if (
			rows.some((row) => row.source === relative) ||
			!/\.(?:Dockerfile|sh|ya?ml)$/.test(name)
		)
			continue;
		const owner = projects
			.filter((project) => name.startsWith(`${String(project.id)}-`))
			.sort((a, b) => String(b.id).length - String(a.id).length)[0];
		const present = owner?.targets.some(
			(target) =>
				typeof target.command === "string" && target.command.includes(name),
		);
		try {
			const capturedScript = capture(relative);
			if (
				directory === "apps/build" &&
				name === "grid-allocation-backend-build.sh" &&
				owner
			) {
				const removed = owner.targets.filter(
					(target) =>
						target.runtime === "shell" &&
						typeof target.command === "string" &&
						target.command.includes(name),
				);
				owner.targets = owner.targets.filter(
					(target) => !removed.includes(target),
				);
				const defaults = { ...object(owner.defaults ?? {}) };
				for (const [action, target] of Object.entries(defaults))
					if (removed.some((entry) => entry.id === target))
						delete defaults[action];
				owner.defaults = defaults;
				if (digest(capturedScript) !== hostBuildSourceDigest)
					throw new Refusal(
						"Host Maven/image source differs from the reviewed native protocol; obsolete shell Docker wrapper removed, unknown effects not translated",
					);
				const existing = owner.targets.find(
					(target) => target.id === "build-host-image",
				);
				if (removed.length > 1 || (removed.length && existing))
					throw new Refusal(
						"Host image source conflicts with existing native target selections",
					);
				if (
					existing &&
					(existing.runtime !== "docker" ||
						object(existing.container).hostPreparation !==
							"spring-boot-layers-v1" ||
						object(existing.container).image !==
							"devenv-grid-allocation-backend:latest" ||
						object(existing.container).dockerfileSource !== hostBuildDockerfile)
				)
					throw new Refusal(
						"Existing native host image pipeline differs; explicit reconciliation required",
					);
				const previous = removed[0] ?? existing ?? {},
					target = {
						...previous,
						id: "build-host-image",
						action: "build",
						runtime: "docker",
						profile: "default",
						label: "Build image (host Maven, native image build)",
						timeoutMs: 3600000,
						command: undefined,
						container: {
							image: "devenv-grid-allocation-backend:latest",
							socket,
							hostPreparation: "spring-boot-layers-v1",
							dockerfileSource: hostBuildDockerfile,
						},
					};
				validateProjects(config, {
					version: 1,
					projects: [
						{
							...owner,
							defaults: undefined,
							requires: undefined,
							prerequisites: undefined,
							targets: [target],
						},
					],
				});
				owner.targets = owner.targets.filter((entry) => entry !== existing);
				owner.targets.push(target);
				for (const ref of Object.values(object(previous.secretRefs ?? {})))
					if (typeof ref === "string") required.add(ref);
				rows.push({
					app: String(owner.id),
					source: relative,
					target: target.id,
					status: "candidate",
					reason:
						"Reviewed source digest translated to argv-only host Maven/Java preparation and the owned native image adapter; legacy shell Docker program is not executed",
				});
				continue;
			}
			if (
				directory === "apps/build" &&
				owner &&
				[
					"grid-allocation-backend-test.sh",
					"grid-allocation-frontend-build.sh",
					"grid-allocation-frontend-test.sh",
				].includes(name)
			) {
				if (capturedScript.length > 16000)
					throw new Refusal(
						"Known self-contained shell source exceeds native command bounds",
					);
				const selected = owner.targets.filter(
					(target) =>
						target.runtime === "shell" &&
						typeof target.command === "string" &&
						(target.command.includes(name) ||
							target.command === capturedScript),
				);
				if (selected.length > 1)
					throw new Refusal(
						"Known shell source matches conflicting native targets",
					);
				const action = name.endsWith("-build.sh") ? "build" : "test",
					id = `${action}-shell-default`;
				let target = selected[0];
				if (!target) {
					if (owner.targets.some((entry) => entry.id === id))
						throw new Refusal(
							"Known shell source would overwrite another native target",
						);
					target = {
						id,
						action,
						runtime: "shell",
						profile: "default",
						timeoutMs: 3600000,
						command: capturedScript,
					};
					owner.targets.push(target);
				}
				target.command = capturedScript;
				const label = /^# devenv:name=(.+)$/m.exec(capturedScript)?.[1]?.trim();
				if (label && label.length <= 200) target.label = label;
				rows.push({
					app: String(owner.id),
					source: relative,
					target: String(target.id),
					status: "candidate",
					reason:
						"Self-contained shell source captured in the reviewed definition; no mutable v1/config script dispatcher retained",
				});
				continue;
			}
			rows.push({
				app: owner ? String(owner.id) : "infrastructure",
				source: relative,
				status: present ? "already-present" : "blocked",
				reason: present
					? "Existing v2 script target preserved without changing its bytes or execution authority"
					: directory === "infrastructure/compose"
						? "Global infrastructure needs explicit repository/dependency/network mapping; not silently duplicated"
						: directory === "apps/run"
							? "Script prerequisite/readiness conversion is required; script is not enabled as a dependency-bypassing wrapper"
							: "Unrecognized source filename is not inferred as a runnable target",
			});
		} catch (error) {
			rows.push({
				app: owner ? String(owner.id) : "unassigned",
				source: relative,
				status: "blocked",
				reason:
					error instanceof Refusal
						? error.message
						: "Source capture refused; values withheld",
			});
		}
	}
}
const defaultDecisions: {
	app: string;
	action: string;
	status: string;
	target?: string;
	reason?: string;
}[] = [];
for (const project of projects) {
	const id = String(project.id),
		defaults = { ...object(project.defaults ?? {}) },
		relative = `apps/defaults/${id}.json`;
	let declared: Record<string, unknown> = {};
	try {
		if (fs.existsSync(path.join(source, relative))) {
			declared = object(JSON.parse(capture(relative)));
			if (
				Object.entries(declared).some(
					([action, value]) =>
						!["build", "test", "run"].includes(action) ||
						typeof value !== "string" ||
						!value.trim(),
				)
			)
				throw new Refusal("Malformed default declaration");
		}
	} catch {
		rows.push({
			app: id,
			source: relative,
			status: "blocked",
			reason: "Default declaration unavailable/malformed; values withheld",
		});
		continue;
	}
	for (const action of ["build", "test", "run"]) {
		if (defaults[action] !== undefined) {
			defaultDecisions.push({
				app: id,
				action,
				status: infrastructureProjects.has(id)
					? "captured-infrastructure"
					: "existing-native-retained",
				target: String(defaults[action]),
			});
			continue;
		}
		const all = project.targets.filter(
			(target) => target.action === action && target.runtime !== "kubernetes",
		);
		const legacyRuntime = (target: Record<string, unknown>) =>
			target.container && object(target.container).hostPreparation
				? "shell"
				: target.runtime === "compose"
					? "docker"
					: String(target.runtime);
		const runtimeRank = (target: Record<string, unknown>) =>
			[
				"docker",
				"shell",
				"podman",
				"systemshell",
				"powershell",
				"kubernetes",
			].indexOf(legacyRuntime(target));
		const preferred = all.filter(
				(target) =>
					target.profile === undefined || target.profile === "default",
			),
			considered = (preferred.length ? preferred : all).sort(
				(a, b) =>
					runtimeRank(a) - runtimeRank(b) ||
					`${a.profile ?? ""}/${a.id}`.localeCompare(
						`${b.profile ?? ""}/${b.id}`,
					),
			);
		let chosen: Record<string, unknown> | undefined;
		const wanted = declared[action];
		if (
			id === "grid-allocation-backend" &&
			action === "build" &&
			rows.some(
				(row) =>
					row.source === "apps/build/grid-allocation-backend-build.sh" &&
					row.status === "blocked",
			)
		) {
			defaultDecisions.push({
				app: id,
				action,
				status: "blocked",
				reason:
					"Host Maven plus image packaging has not been translated; a plain Maven target is not an equivalent default",
			});
			continue;
		}
		if (typeof wanted === "string") {
			const matchesDeclaration = (target: Record<string, unknown>) => {
				const runtime = legacyRuntime(target),
					profile =
						typeof target.profile === "string" ? target.profile : "default";
				return [
					target.id,
					target.label,
					runtime,
					...(["docker", "podman"].includes(runtime)
						? ["container"]
						: runtime === "shell"
							? ["command-shell", "script"]
							: []),
					`app/${id}/${action}/${runtime}`,
					`app/${id}/${action}/${runtime}/${profile}`,
					`app/${id}/action/${action}/${runtime}/${profile}`,
				].includes(wanted.trim());
			};
			const preferredMatches = considered.filter(matchesDeclaration),
				matches = preferredMatches.length
					? preferredMatches
					: all.filter(matchesDeclaration);
			if (
				matches.length === 1 ||
				(matches.length &&
					[
						"docker",
						"podman",
						"shell",
						"container",
						"script",
						"command-shell",
						"systemshell",
						"powershell",
					].includes(wanted.trim()))
			)
				chosen = matches[0];
			else {
				defaultDecisions.push({
					app: id,
					action,
					status: "blocked",
					reason:
						"Declared v1 default is missing or ambiguous in converted targets; no fallback",
				});
				continue;
			}
		} else {
			const blockedDefault = rows.some(
				(row) =>
					row.app === id &&
					row.status === "blocked" &&
					(action === "run"
						? row.source === `apps/compose/${id}-compose.yml` ||
							row.source === `apps/run/${id}-default.sh`
						: row.source === `apps/build/${id}-${action}.Dockerfile`),
			);
			if (blockedDefault) {
				defaultDecisions.push({
					app: id,
					action,
					status: "blocked",
					reason:
						"An unmigrated default-profile source must not silently fall back to another tool/profile",
				});
				continue;
			}
			const families = new Set(
				considered.map((target) =>
					["docker", "podman"].includes(legacyRuntime(target))
						? "container"
						: legacyRuntime(target),
				),
			);
			if (considered.length && (families.size === 1 || action === "run"))
				chosen = considered[0];
		}
		if (chosen && typeof chosen.id === "string") {
			defaults[action] = chosen.id;
			defaultDecisions.push({
				app: id,
				action,
				status:
					typeof wanted === "string"
						? "declared-v1"
						: "v1-profile-family-order",
				target: chosen.id,
			});
		} else if (all.length)
			defaultDecisions.push({
				app: id,
				action,
				status: "ambiguous",
				reason:
					"Different synchronous runtime families require an explicit default; none invented",
			});
	}
	if (Object.keys(defaults).length) project.defaults = defaults;
}
const content = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`;
if (Buffer.byteLength(content) > definitionByteLimit)
	throw new Refusal("Converted preview exceeds native definition bundle bound");
validateProjects(config, JSON.parse(content));
const report = {
	version: 1,
	status: "inert-incomplete-preview",
	liveConfigurationChanged: false,
	execution: "none",
	runtimeValidated: false,
	fullParityArchived: false,
	requiredRepositoryApprovals: requiredRepositories,
	infrastructureMapping: infrastructureRoot
		? {
				status: infrastructureProjects.size === 7 ? "candidate" : "blocked",
				projects: [...infrastructureProjects],
				recommendedOperatorLifetime: "operator-infrastructure-v3",
				lifetimeEnforcedByConfiguration: false,
				services: infrastructureIds.map((id) => `host-infra-${id}`),
				effectsNotClaimed: [
					"existing-container adoption or legacy bridge/volume reuse",
					"existing legacy volume contents",
					"all-interface legacy port exposure (native publications are loopback-only)",
					"cross-owner host consumption",
					"service health beyond the captured source readiness",
					"live compatibility or publication approval",
				],
			}
		: {
				status: "not-requested",
				reason:
					"An explicit --infrastructure-repository is required; no repository or host lifetime is inferred",
			},
	baseDigest: digest(base),
	definitionDigest: digest(content),
	bytes: Buffer.byteLength(content),
	projects: projects.length,
	targets: projects.reduce(
		(count, project) => count + project.targets.length,
		0,
	),
	references: [...required].sort(),
	sources: [...manifest.values()].sort((a, b) => a.file.localeCompare(b.file)),
	rows,
	repositoryDiscovery,
	defaultDecisions,
	remaining: [
		"changed host-Maven/image source versions and existing-native override reconciliation require explicit metadata review",
		infrastructureProjects.size === 7
			? "cross-owner host consumption still requires an explicit native attachment authority; protected same-owner source mapping is available"
			: "global infrastructure source mapping requires an explicit --infrastructure-repository; no host workspace inferred",
		...(requiredRepositories.length
			? [
					"explicit native repository policy approval is required before this proposed infrastructure mapping can pass live preflight",
				]
			: []),
		"application-prerequisite migration where the required backend target remains unavailable",
		"separately authorized real collector-image/network acceptance; native pinned HTTPS/bearer transport and live attribution are implemented",
		"default reconciliation for existing native overrides and any blocked/ambiguous declarations; generic process-start hints are not service health",
		"Helm-discovered targets",
		"literal/default/embedded credentials and missing reference inputs",
		"exact native developer publication approval",
	],
};
fs.mkdirSync(output, { mode: 0o700 });
fs.writeFileSync(path.join(output, "environments.json"), content, {
	mode: 0o600,
	flag: "wx",
});
fs.writeFileSync(
	path.join(output, "report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
	{ mode: 0o600, flag: "wx" },
);
console.log(
	JSON.stringify({
		output,
		status: report.status,
		definitionDigest: report.definitionDigest,
		projects: report.projects,
		targets: report.targets,
		candidates: rows.filter((row) => row.status === "candidate").length,
		blocked: rows.filter((row) => row.status === "blocked").length,
		blockedDefaults: defaultDecisions.filter(
			(decision) => decision.status === "blocked",
		).length,
		ambiguousDefaults: defaultDecisions.filter(
			(decision) => decision.status === "ambiguous",
		).length,
		credentialValuesCopied: false,
		workloadsExecuted: false,
	}),
);
