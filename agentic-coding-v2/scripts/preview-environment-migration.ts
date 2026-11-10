// Offline, inert conversion only. Never executes discovery commands, imports v1
// runtime code, writes live configuration, reads credential values, or applies a plan.
import fs from "node:fs";
import path from "node:path";
import { digest, loadConfig, object } from "../src/config.ts";
import { validateProjects } from "../src/environment/catalog.ts";
import {
	compileCompose,
	readCompose,
} from "../src/environment/compose-config.ts";
import {
	composeArgv,
	composeEnvironment,
} from "../src/environment/compose-values.ts";
import { definitionByteLimit } from "../src/environment/definition-limits.ts";

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
	npmrc = flag("--npmrc-reference", false);
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
const config = loadConfig(
	path.join(output, "unused-validation-state"),
	process.cwd(),
	current,
);
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
	return { source: Bun.YAML.stringify(merged), refs: [...refs].sort() };
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
				profile: safeId(name.slice(id.length + 1, -"-compose.yml".length)),
			});
	}
	for (const candidate of candidates) {
		const targetId = `${candidate.action}-${candidate.action === "run" ? "compose" : "docker"}-${candidate.profile}`;
		try {
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
				compileCompose(repository, readCompose(definition));
				target = {
					id: targetId,
					action: "run",
					runtime: "compose",
					profile: candidate.profile,
					timeoutMs: 180000,
					compose: definition,
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
			capture(relative);
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
const content = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`;
if (Buffer.byteLength(content) > definitionByteLimit)
	throw new Refusal("Converted preview exceeds native definition bundle bound");
validateProjects(config, JSON.parse(content));
const report = {
	version: 1,
	status: "inert-incomplete-preview",
	liveConfigurationChanged: false,
	execution: "none",
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
	remaining: [
		"global/shared infrastructure topology and live network lifetime",
		"cross-repository app prerequisites",
		"container telemetry transport and attribution",
		"repository-discovered targets and defaults/profiles",
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
		credentialValuesCopied: false,
		workloadsExecuted: false,
	}),
);
