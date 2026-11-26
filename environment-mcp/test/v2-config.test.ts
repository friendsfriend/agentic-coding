import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBuildSecrets } from "../src/configuration/build-secrets.ts";
import {
	loadSecretFile,
	loadSecretSource,
	renderTemplate,
} from "../src/configuration/secrets.ts";
import { readV2Configuration } from "../src/configuration/v2-configuration.ts";
import { createCatalogService } from "../src/services/catalog-service.ts";

test("the standalone server reads the v2 environments.json structure directly", () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-v2-config-")),
	);
	const repository = path.join(root, "repo"),
		configDir = path.join(root, "config");
	fs.mkdirSync(repository);
	fs.mkdirSync(configDir);
	fs.mkdirSync(path.join(repository, "chart", "templates"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(repository, "chart", "Chart.yaml"),
		"apiVersion: v2\nname: fixture\nversion: 0.1.0\ntype: application\n",
	);
	fs.writeFileSync(
		path.join(repository, "chart", "templates", "deployment.yaml"),
		"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: fixture\nspec: {}\n",
	);
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ repositories: [repository], unrelated: true }),
	);
	fs.writeFileSync(
		path.join(root, ".npmrc"),
		"registry=https://example.invalid\n",
	);
	fs.writeFileSync(
		path.join(configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			serviceBindings: {
				postgres: {
					kind: "docker-container",
					socket: "/configured-only/docker.sock",
					containerName: "postgres",
					image: "postgres:17.4",
					labels: { "com.docker.compose.project": "existing-mocked" },
					network: { name: "existing-mocked_devenv-local", alias: "postgres" },
					readiness: "running",
				},
			},
			projects: [
				{
					id: "installer-space-mw",
					kind: "app",
					repository,
					defaults: { run: "mocked" },
					targets: [
						{
							id: "build-shell",
							action: "build",
							runtime: "shell",
							profile: "maven",
							command: '"mvn" "package"',
							timeoutMs: 600000,
							secretRefs: { TOKEN: "ARTIFACTORY_PASSWORD" },
							environment: { PUBLIC: "value" },
							requires: [{ infra: "postgres" }],
						},
						{
							id: "mocked",
							action: "run",
							runtime: "compose",
							profile: "Mocked",
							timeoutMs: 180000,
							endpoints: { api: "http://127.0.0.1:8081/health" },
							endpointServices: { api: "api" },
							telemetry: {
								protocol: "otlp-http-json",
								listen: "0.0.0.0:0",
								collectorService: "collector",
								transport: "tls-host-gateway-v1",
							},
							compose: {
								file: "compose.captured.yaml",
								source:
									'name: fixture-stack\nservices:\n  api:\n    image: example:latest\n    x-secret-refs:\n      API_TOKEN: TEST_TOKEN\n      API-TOKEN: TEST_TOKEN_TWO\n  redis:\n    image: redis:latest\n  collector:\n    image: otel/opentelemetry-collector-contrib:0.162.0\n    container_name: environment-mcp-fixture-otel-collector\n    command: ["--config=env:OTEL_COLLECTOR_CONFIG"]\n    extra_hosts: ["host.docker.internal:host-gateway"]\n    environment: {}\n',
								provider: "docker",
								socket: "/configured-only/docker.sock",
								network: "shared",
							},
						},
						{
							id: "run-shell",
							action: "run",
							runtime: "shell",
							profile: "dev",
							command: "npm run dev",
							timeoutMs: 180000,
							readyUrl: "http://127.0.0.1:5173/",
						},
						{
							id: "bad-compose",
							action: "run",
							runtime: "compose",
							compose: {
								file: "compose.captured.yaml",
								source:
									"services:\n  api:\n    image: example:latest\n    container_name: api\n",
								socket: "/configured-only/docker.sock",
							},
						},
						{
							id: "build-podman",
							action: "build",
							runtime: "podman",
							container: {
								image: "example:podman",
								socket: "/configured-only/podman.sock",
								dockerfileSource: "FROM scratch\n",
							},
						},
						{
							id: "run-container",
							action: "run",
							runtime: "docker",
							telemetry: {
								protocol: "otlp-http-json",
								listen: "0.0.0.0:0",
							},
							container: {
								socket: "/configured-only/docker.sock",
								image: "example:container",
								ports: [{ host: 8075, container: 80, address: "127.0.0.1" }],
							},
						},
						{
							id: "run-helm",
							action: "run",
							runtime: "kubernetes",
							timeoutMs: 600000,
							kubernetes: {
								cluster: "devenv",
								namespace: "default",
								workload: "helm-release-v1",
								helm: { chart: "chart", release: "fixture" },
							},
						},
						{
							id: "net",
							action: "run",
							runtime: "compose",
							compose: {
								file: "net.yaml",
								source: "services: {}\n",
								provider: "docker",
								socket: "/configured-only/docker.sock",
								network: "shared",
								networkOnly: true,
							},
						},
						{
							id: "member",
							action: "run",
							runtime: "compose",
							compose: {
								file: "member.yaml",
								source:
									"services:\n  api:\n    image: example:latest\n    container_name: environment-mcp-member\n",
								provider: "docker",
								socket: "/configured-only/docker.sock",
								network: "shared",
								networkFrom: {
									app: "installer-space-mw",
									target: "net",
								},
							},
						},
						{
							id: "build-image",
							action: "build",
							runtime: "docker",
							timeoutMs: 3600000,
							container: {
								image: "example:local",
								socket: "/configured-only/docker.sock",
								dockerfileSource: "FROM scratch\n",
								buildSecrets: {
									settings: {
										// biome-ignore lint/suspicious/noTemplateCurlyInString: literal v2 template placeholder
										template: "<settings>${USER}</settings>",
										encoding: "xml",
										refs: { USER: "ARTIFACTORY_USERNAME" },
									},
									npmrc: { file: path.join(root, ".npmrc") },
								},
							},
						},
					],
				},
			],
		}),
	);
	const manifest = readV2Configuration(configDir);
	expect(manifest.repositories).toEqual([repository]);
	expect(manifest.services).toMatchObject([
		{
			id: "postgres",
			runtime: "docker",
			binding: { containerName: "postgres" },
		},
	]);
	const app = manifest.apps[0];
	expect(app?.defaults).toEqual({ run: "mocked" });
	expect(app?.targets[0]).toMatchObject({
		id: "build-shell",
		action: "build",
		profile: "maven",
		dependsOn: [{ service: "postgres", lifecycle: "shared" }],
		executable: {
			kind: "command",
			program: "/bin/sh",
			args: ["-lc", '"mvn" "package"'],
			env: { PUBLIC: "value" },
			envRefs: { TOKEN: "ARTIFACTORY_PASSWORD" },
		},
	});
	expect(app?.targets[1]?.executable).toMatchObject({
		kind: "compose",
		source: expect.stringContaining("fixture-stack"),
		project: "environment-mcp",
		services: ["api", "redis", "collector"],
		serviceEnvRefs: {
			api: { API_TOKEN: "TEST_TOKEN", "API-TOKEN": "TEST_TOKEN_TWO" },
		},
		telemetry: {
			protocol: "otlp-http-json",
			collectorService: "collector",
			transport: "tls-host-gateway-v1",
		},
	});
	expect(app?.targets[1]?.endpoints).toEqual({
		api: "http://127.0.0.1:8081/health",
	});
	expect(app?.targets[1]?.endpointServices).toEqual({ api: "api" });
	expect(app?.targets[2]?.executable).toMatchObject({
		kind: "process",
		program: "/bin/sh",
		args: ["-lc", "npm run dev"],
		readyUrl: "http://127.0.0.1:5173/",
		timeoutSec: 180,
	});
	expect(app?.targets[3]).toMatchObject({
		executionIssue: "container-name-prefix",
	});
	expect(app?.targets[4]?.executable).toMatchObject({
		kind: "docker-build",
		provider: "podman",
		image: "example:podman",
	});
	expect(app?.targets[5]?.executable).toMatchObject({
		kind: "container-run",
		provider: "docker",
		image: "example:container",
		name: "environment-mcp-installer-space-mw-run-container",
		ports: [{ host: 8075, container: 80, address: "127.0.0.1" }],
		telemetry: "otlp-http-json",
	});
	expect(app?.targets[6]?.executable).toMatchObject({
		kind: "helm-release",
		cluster: "devenv",
		namespace: "default",
		release: "fixture",
		values: [],
		setString: {},
	});
	expect(
		(app?.targets[6]?.executable as { chartDigest?: string } | undefined)
			?.chartDigest,
	).toMatch(/^[a-f0-9]{64}$/);
	expect(app?.targets[7]?.executable).toMatchObject({
		kind: "network-only",
		provider: "docker",
		app: "installer-space-mw",
		target: "net",
	});
	expect(app?.targets[8]?.executable).toMatchObject({
		kind: "compose",
		networkFrom: {
			app: "installer-space-mw",
			target: "net",
		},
	});
	expect(app?.targets[9]?.executable).toMatchObject({
		kind: "docker-build",
		image: "example:local",
		dockerfileSource: "FROM scratch\n",
		secrets: [
			{
				kind: "template",
				id: "settings",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal v2 template placeholder
				template: "<settings>${USER}</settings>",
				encoding: "xml",
				refs: { USER: "ARTIFACTORY_USERNAME" },
			},
			{ kind: "file", id: "npmrc", file: path.join(root, ".npmrc") },
		],
	});
	const build = app?.targets[9]?.executable;
	if (build?.kind !== "docker-build") throw new Error("Missing build fixture");
	expect(
		resolveBuildSecrets(build.secrets, {
			get: (reference) =>
				reference === "ARTIFACTORY_USERNAME" ? "a&b" : undefined,
		}),
	).toEqual({
		settings: "<settings>a&amp;b</settings>",
		npmrc: "registry=https://example.invalid\n",
	});
	const catalog = createCatalogService({
		file: path.join(configDir, "environments.json"),
		format: "v2-config",
		repositories: [],
	});
	expect(catalog.list({ offset: 0, limit: 10 })).toMatchObject({
		format: "v2-config",
		validation: "v2-config-native",
		apps: [{ id: "installer-space-mw" }],
		repositories: [repository],
	});
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ repositories: [path.join(root, "other")] }),
	);
	expect(() => catalog.list({ offset: 0, limit: 10 })).toThrow();
});

test("explicit provider secret files may be symlinks but must resolve private", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-secret-file-"));
	const target = path.join(root, "environment.env");
	const link = path.join(root, "provider.env");
	try {
		fs.writeFileSync(target, "GITLAB_TOKEN=fixture-token\n", { mode: 0o600 });
		fs.symlinkSync(target, link);
		const secrets = loadSecretFile(link);
		expect(secrets.get("GITLAB_TOKEN")).toBe("fixture-token");
		fs.chmodSync(target, 0o644);
		expect(() => loadSecretFile(link)).toThrow("Invalid secret file");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("configuration secrets use the v2 config-root .env with process fallback and strict templates", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-secrets-"));
	fs.writeFileSync(
		path.join(root, ".env"),
		"ARTIFACTORY_USERNAME=file-user\nARTIFACTORY_PASSWORD=file-pass\n",
	);
	process.env.MCP_SECRET_FALLBACK = "process-value";
	const secrets = loadSecretSource(root);
	try {
		expect(secrets.get("ARTIFACTORY_USERNAME")).toBe("file-user");
		expect(secrets.get("MCP_SECRET_FALLBACK")).toBe("process-value");
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal template placeholder
			renderTemplate("<user>${ARTIFACTORY_USERNAME}</user>", secrets, {
				ARTIFACTORY_USERNAME: "ARTIFACTORY_USERNAME",
			}),
		).toBe("<user>file-user</user>");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal template placeholder
		expect(() => renderTemplate("${UNKNOWN}", secrets, {})).toThrow(
			"unresolved-template-reference",
		);
		expect(() =>
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal template placeholder
			renderTemplate("${X}", secrets, { X: "MISSING_REFERENCE" }),
		).toThrow("secret-reference-unavailable");
	} finally {
		delete process.env.MCP_SECRET_FALLBACK;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
