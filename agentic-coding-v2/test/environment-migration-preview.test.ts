import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { digest } from "../src/config.ts";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
function client(host: ReturnType<typeof serve>) {
	const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get(
		"token",
	);
	return (route: string, body: unknown) =>
		fetch(new URL(route, host.url), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
}

test("offline migration captures an include closure and converts every Maven RUN without publishing, invoking workloads or copying credentials", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
	});
	const root = path.dirname(config.configDir),
		source = path.join(root, "v1-source"),
		output = path.join(root, "preview");
	for (const directory of [
		"apps/build",
		"apps/compose",
		"apps/run",
		"infrastructure/compose",
		"templates",
	])
		fs.mkdirSync(path.join(source, directory), { recursive: true });
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ profiles: {}, repositories: config.repositories }),
	);
	const base = JSON.stringify({
		version: 1,
		projects: [
			{
				id: "demo",
				kind: "app",
				repository: config.repositories[0],
				targets: [],
			},
			...["grid-allocation-backend", "grid-allocation-frontend"].map((id) => ({
				id,
				kind: "app",
				repository: config.repositories[0],
				targets: [],
			})),
		],
	});
	fs.writeFileSync(path.join(config.configDir, "environments.json"), base);
	fs.writeFileSync(
		path.join(source, "apps/build/demo-build.Dockerfile"),
		"FROM fixture:latest\nRUN --mount=type=bind,source=settings.xml,target=settings.xml \\\n    mvn -s settings.xml dependency:go-offline\nCOPY . .\nRUN mvn -s settings.xml package\n",
	);
	fs.writeFileSync(
		path.join(source, "templates/settings.xml"),
		`<settings><username>\${ARTIFACTORY_USERNAME}</username><password>\${ARTIFACTORY_PASSWORD}</password></settings>`,
	);
	fs.writeFileSync(
		path.join(source, "apps/compose/demo-compose.yml"),
		"include: [../../infrastructure/compose/db.yml, ../../infrastructure/compose/network.yml]\nservices:\n  demo:\n    image: fixture:latest\n    networks: [local]\n    depends_on: [db]\n",
	);
	fs.writeFileSync(
		path.join(source, "infrastructure/compose/db.yml"),
		`services:\n  db:\n    image: fixture:latest\n    command: redis-server --requirepass literal-never-copy --maxmemory 256mb\n    networks: [local]\n    restart: always\n    environment:\n      PASSWORD: \${FIXTURE_DB_PASSWORD}\n    volumes: [data:/data]\nvolumes:\n  data: {}\n`,
	);
	fs.writeFileSync(
		path.join(source, "infrastructure/compose/network.yml"),
		"networks:\n  local:\n    driver: bridge\n",
	);
	fs.writeFileSync(
		path.join(source, "apps/compose/grid-allocation-backend-compose.yml"),
		"services:\n  backend:\n    image: fixture:latest\n",
	);
	fs.writeFileSync(
		path.join(source, "apps/run/grid-allocation-frontend-default.sh"),
		'#!/bin/sh\n# devenv:requires=[{"app":"grid-allocation-backend","runtime":"docker","profile":"default"}]\n# devenv:ready=http://127.0.0.1:55321/\ntouch must-never-execute\n',
	);
	const result = Bun.spawnSync(
		[
			process.execPath,
			path.join(import.meta.dir, "../scripts/preview-environment-migration.ts"),
			"--source-config",
			source,
			"--current-config",
			config.configDir,
			"--output",
			output,
			"--socket",
			path.join(config.stateDir, "never-contacted.sock"),
		],
		{ stdout: "pipe", stderr: "pipe", cwd: config.repositories[0] },
	);
	expect(result.exitCode).toBe(0);
	const report = JSON.parse(
		fs.readFileSync(path.join(output, "report.json"), "utf8"),
	);
	expect(
		report.rows.filter((row: { status: string }) => row.status === "candidate"),
	).toHaveLength(5);
	expect(report.sources).toHaveLength(7);
	expect(report.baseDigest).toBe(digest(base));
	expect(report.liveConfigurationChanged).toBe(false);
	expect(
		fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
	).toBe(base);
	const content = fs.readFileSync(
			path.join(output, "environments.json"),
			"utf8",
		),
		converted = JSON.parse(content);
	const build = converted.projects[0].targets.find(
		(target: { action: string }) => target.action === "build",
	);
	expect(build.container.dockerfileSource.match(/id=settings/g)).toHaveLength(
		2,
	);
	expect(build.container.dockerfileSource).not.toContain("source=settings.xml");
	expect(build.secretRefs.ARTIFACTORY_PASSWORD).toBe("ARTIFACTORY_PASSWORD");
	expect(report.references).toContain("FIXTURE_DB_PASSWORD");
	expect(content).not.toContain("literal-never-copy");
	expect(content).toContain("ACV2_REDIS_PASSWORD");
	expect(report.references).toContain("V2_DB_PASSWORD");
	const frontend = converted.projects.find(
		(project: { id: string }) => project.id === "grid-allocation-frontend",
	);
	expect(frontend.targets[0].prerequisites).toEqual([
		{ app: "grid-allocation-backend", target: "run-compose-default" },
	]);
	expect(frontend.targets[0].readyUrl).toBe("http://127.0.0.1:55321/");
	expect(frontend.targets[0].command).toContain("touch must-never-execute");
	const system = frontend.targets.find(
		(target: { runtime: string }) => target.runtime === "systemshell",
	);
	expect(system.command).toBe(frontend.targets[0].command);
	expect(system.prerequisites).toEqual(frontend.targets[0].prerequisites);
	expect(system.readyUrl).toBe(frontend.targets[0].readyUrl);
	expect(system.profile).toBe("default");
	expect(
		fs.existsSync(
			path.join(config.repositories[0] ?? "", "must-never-execute"),
		),
	).toBe(false);
	const host = serve(app);
	try {
		const post = client(host),
			stagedResponse = await post("/api/environments/drafts", {
				requestId: "migration-preview",
				content,
			});
		expect(stagedResponse.status).toBe(200);
		const staged = await stagedResponse.json();
		const preflight = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "migration-check",
				id: staged.id,
				revision: staged.revision,
				digest: staged.digest,
			})
		).json();
		expect(preflight.schemaAccepted).toBe(true);
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe(base);
	} finally {
		host.stop();
	}
	const retry = Bun.spawnSync(
		[
			process.execPath,
			path.join(import.meta.dir, "../scripts/preview-environment-migration.ts"),
			"--source-config",
			source,
			"--current-config",
			config.configDir,
			"--output",
			output,
			"--socket",
			path.join(config.stateDir, "never-contacted.sock"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(retry.exitCode).not.toBe(0);
}, 15000);

test("authenticated definition staging supports installation-sized captured bundles but preserves source and promotion fences", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
	});
	const source = `${"# inert fixture padding\n".repeat(100)}services:\n  demo:\n    image: fixture:latest\n`;
	const projects = Array.from({ length: 34 }, (_, index) => ({
		id: `project-${index}`,
		kind: "app",
		repository: config.repositories[0],
		targets: [
			{
				id: "run",
				action: "run",
				runtime: "compose",
				compose: {
					file: "compose.captured.yaml",
					source,
					provider: "docker",
					socket: path.join(config.stateDir, "never-contacted.sock"),
				},
			},
		],
	}));
	const content = JSON.stringify({ version: 1, projects });
	expect(Buffer.byteLength(content)).toBeGreaterThan(65536);
	const host = serve(app);
	try {
		const post = client(host),
			response = await post("/api/environments/drafts", {
				requestId: "installation-sized",
				content,
			});
		expect(response.status).toBe(200);
		const staged = await response.json();
		const preflight = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "sized-check",
				id: staged.id,
				revision: staged.revision,
				digest: staged.digest,
			})
		).json();
		expect(preflight.schemaAccepted).toBe(true);
		const candidate = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "sized-candidate",
				id: staged.id,
				revision: staged.revision,
				digest: staged.digest,
				validateStagedCandidate: true,
			})
		).json();
		expect(candidate.accepted).toBe(true);
		expect(candidate.entries).toHaveLength(34);
		expect(candidate.runtimeChecked).toBe(false);
		expect(candidate.publicationAllowed).toBe(false);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
		const oversized = await post("/api/environments/drafts", {
			requestId: "too-large",
			content: "x".repeat(262145),
		});
		expect(oversized.status).toBeGreaterThanOrEqual(400);
	} finally {
		host.stop();
	}
}, 15000);

test("offline native repository migration preserves language profiles, v1 package fallback and explicit defaults without enabling an unmigrated default dependency", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
	});
	const root = path.dirname(config.configDir),
		source = path.join(root, "v1-repositories"),
		output = path.join(root, "repository-preview"),
		sdk = path.join(root, "sdk"),
		repository = config.repositories[0] ?? "",
		marker = "repository-private-body-never-returned";
	fs.mkdirSync(sdk);
	config.repositories.push(fs.realpathSync(sdk));
	for (const directory of [
		"apps/build",
		"apps/compose",
		"apps/run",
		"apps/defaults",
		"infrastructure/compose",
	])
		fs.mkdirSync(path.join(source, directory), { recursive: true });
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ profiles: {}, repositories: config.repositories }),
	);
	const base = JSON.stringify({
		version: 1,
		projects: [
			{
				id: "demo",
				kind: "app",
				repository,
				targets: [
					{
						id: "preferred-old",
						action: "build",
						runtime: "shell",
						profile: "default",
						command: "true",
					},
				],
			},
			{ id: "blocked", kind: "app", repository, targets: [] },
			{
				id: "grid-allocation-backend",
				kind: "app",
				repository,
				defaults: { build: "build-shell" },
				targets: [
					{
						id: "build-shell",
						action: "build",
						runtime: "shell",
						command:
							'sh "$CONFIG_DIR/scripts/grid-allocation-backend-build.sh"',
					},
				],
			},
			{
				id: "sdk",
				kind: "library",
				repository: fs.realpathSync(sdk),
				targets: [],
			},
		],
	});
	fs.writeFileSync(path.join(config.configDir, "environments.json"), base);
	fs.writeFileSync(
		path.join(repository, "package.json"),
		JSON.stringify({
			scripts: {
				build: marker,
				test: marker,
				dev: "touch migration-must-not-run",
			},
			credentials: marker,
		}),
	);
	fs.writeFileSync(
		path.join(repository, "gradlew"),
		"#!/bin/sh\ntouch migration-must-not-run\n",
	);
	fs.writeFileSync(path.join(repository, "pom.xml"), marker);
	fs.writeFileSync(
		path.join(source, "apps/build/grid-allocation-backend-build.sh"),
		"#!/bin/sh\nmvn package\ndocker build .\n",
	);
	const nativeUnitTest =
		"#!/bin/sh\n# devenv:name=Host unit tests\nexec mvn test -P unit-test\n";
	fs.writeFileSync(
		path.join(source, "apps/build/grid-allocation-backend-test.sh"),
		nativeUnitTest,
	);
	fs.writeFileSync(path.join(sdk, "Cargo.toml"), marker);
	fs.writeFileSync(path.join(sdk, "pyproject.toml"), marker);
	fs.writeFileSync(
		path.join(source, "apps/defaults/demo.json"),
		JSON.stringify({ build: "app/demo/build/shell/maven", test: "shell" }),
	);
	fs.writeFileSync(
		path.join(source, "apps/compose/blocked-compose.yml"),
		"services:\n  api:\n    image: fixture:latest\n    unknown_effect: true\n",
	);
	const result = Bun.spawnSync(
		[
			process.execPath,
			path.join(import.meta.dir, "../scripts/preview-environment-migration.ts"),
			"--source-config",
			source,
			"--current-config",
			config.configDir,
			"--output",
			output,
			"--socket",
			path.join(config.stateDir, "never-contacted.sock"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect({
		code: result.exitCode,
		error: result.stderr.toString(),
	}).toMatchObject({ code: 0 });
	const report = JSON.parse(
			fs.readFileSync(path.join(output, "report.json"), "utf8"),
		),
		content = fs.readFileSync(path.join(output, "environments.json"), "utf8"),
		converted = JSON.parse(content),
		demo = converted.projects.find(
			(project: { id: string }) => project.id === "demo",
		),
		library = converted.projects.find(
			(project: { id: string }) => project.id === "sdk",
		),
		blocked = converted.projects.find(
			(project: { id: string }) => project.id === "blocked",
		);
	expect(demo.targets).toHaveLength(9);
	expect(library.targets).toHaveLength(4);
	expect(blocked.targets).toHaveLength(8);
	expect(
		demo.targets.find(
			(target: { id: string }) => target.id === "run-shell-package-npm",
		).command,
	).toBe('"npm" "run" "dev"');
	expect(demo.defaults.build).toBe("build-shell-maven");
	expect(demo.defaults.test).toBe("test-shell-gradle");
	expect(library.defaults).toEqual({
		build: "build-shell-cargo",
		test: "test-shell-cargo",
	});
	expect(
		library.targets.some(
			(target: { action: string }) => target.action === "run",
		),
	).toBe(false);
	expect(blocked.defaults.run).toBeUndefined();
	const backend = converted.projects.find(
		(project: { id: string }) => project.id === "grid-allocation-backend",
	);
	expect(
		backend.targets.some(
			(target: { id: string }) => target.id === "build-shell",
		),
	).toBe(false);
	expect(backend.defaults.build).toBeUndefined();
	expect(backend.defaults.test).toBe("test-shell-default");
	expect(
		backend.targets.find(
			(target: { id: string }) => target.id === "test-shell-default",
		),
	).toMatchObject({ command: nativeUnitTest, label: "Host unit tests" });
	expect(content).not.toContain("docker build");
	expect(report.defaultDecisions).toContainEqual(
		expect.objectContaining({
			app: "grid-allocation-backend",
			action: "build",
			status: "blocked",
		}),
	);
	expect(report.defaultDecisions).toContainEqual(
		expect.objectContaining({
			app: "blocked",
			action: "run",
			status: "blocked",
		}),
	);
	expect(
		report.repositoryDiscovery
			.find((entry: { app: string }) => entry.app === "demo")
			.report.findings.join(" "),
	).toContain("v1 npm fallback");
	expect(
		report.rows.filter((row: { status: string }) => row.status === "candidate"),
	).toHaveLength(29);
	expect(content).not.toContain(marker);
	expect(JSON.stringify(report)).not.toContain(marker);
	expect(fs.existsSync(path.join(repository, "migration-must-not-run"))).toBe(
		false,
	);
	expect(fs.existsSync(path.join(sdk, "migration-must-not-run"))).toBe(false);
	expect(
		fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
	).toBe(base);
	const host = serve(app);
	try {
		const post = client(host),
			staged = await (
				await post("/api/environments/drafts", {
					requestId: "repository-profiles",
					content,
				})
			).json();
		const response = await post("/api/environments/drafts/preflight", {
			requestId: "repository-profile-check",
			id: staged.id,
			revision: staged.revision,
			digest: staged.digest,
		});
		expect(response.status).toBe(200);
		expect((await response.json()).schemaAccepted).toBe(true);
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
	} finally {
		host.stop();
	}
}, 15000);

test("reviewed host-image source digest migrates to native Maven/Java preparation, never a shell Docker program; changed sources remain blocked", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
	});
	const root = path.dirname(config.configDir),
		source = path.join(root, "v1-host-image"),
		repository = config.repositories[0] ?? "",
		guard = path.join(root, "never-run-host-tools"),
		marker = path.join(root, "host-tool-was-run");
	fs.mkdirSync(guard);
	for (const name of ["mvn", "java", "docker"])
		fs.writeFileSync(
			path.join(guard, name),
			`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(99);\n`,
			{ mode: 0o700 },
		);
	for (const directory of [
		"apps/build",
		"apps/compose",
		"apps/run",
		"apps/defaults",
		"infrastructure/compose",
	])
		fs.mkdirSync(path.join(source, directory), { recursive: true });
	fs.writeFileSync(
		path.join(repository, "pom.xml"),
		"<project>inert fixture</project>",
	);
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ profiles: {}, repositories: config.repositories }),
	);
	const base = JSON.stringify({
		version: 1,
		projects: [
			{
				id: "grid-allocation-backend",
				kind: "app",
				repository,
				defaults: { build: "build-shell" },
				targets: [
					{
						id: "build-shell",
						action: "build",
						runtime: "shell",
						command:
							'sh "$CONFIG_DIR/scripts/grid-allocation-backend-build.sh"',
						secretRefs: { ARTIFACTORY_PASSWORD: "ARTIFACTORY_PASSWORD" },
					},
				],
			},
		],
	});
	fs.writeFileSync(path.join(config.configDir, "environments.json"), base);
	fs.writeFileSync(
		path.join(source, "apps/defaults/grid-allocation-backend.json"),
		JSON.stringify({ build: "shell" }),
	);
	const script = fs.readFileSync(
		path.join(import.meta.dir, "fixtures/grid-host-build-source.txt"),
		"utf8",
	);
	const input = path.join(
		source,
		"apps/build/grid-allocation-backend-build.sh",
	);
	fs.writeFileSync(input, script);
	const preview = (directory: string) =>
		Bun.spawnSync(
			[
				process.execPath,
				path.join(
					import.meta.dir,
					"../scripts/preview-environment-migration.ts",
				),
				"--source-config",
				source,
				"--current-config",
				config.configDir,
				"--output",
				directory,
				"--socket",
				path.join(config.stateDir, "never-contacted.sock"),
			],
			{ stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: guard } },
		);
	const output = path.join(root, "host-image-preview");
	expect(preview(output).exitCode).toBe(0);
	const content = fs.readFileSync(
			path.join(output, "environments.json"),
			"utf8",
		),
		converted = JSON.parse(content),
		report = JSON.parse(
			fs.readFileSync(path.join(output, "report.json"), "utf8"),
		),
		project = converted.projects[0],
		target = project.targets.find(
			(target: { id: string }) => target.id === "build-host-image",
		);
	expect(project.defaults.build).toBe("build-host-image");
	expect(target).toMatchObject({
		runtime: "docker",
		action: "build",
		container: {
			hostPreparation: "spring-boot-layers-v1",
			image: "devenv-grid-allocation-backend:latest",
		},
		secretRefs: { ARTIFACTORY_PASSWORD: "ARTIFACTORY_PASSWORD" },
	});
	expect(target.command).toBeUndefined();
	expect(target.container.dockerfileSource).toContain(
		"COPY spring-boot-loader/",
	);
	expect(content).not.toContain("docker build");
	expect(content).not.toContain("$CONFIG_DIR/scripts/");
	expect(report.references).toContain("ARTIFACTORY_PASSWORD");
	const host = serve(app);
	try {
		const post = client(host),
			staged = await (
				await post("/api/environments/drafts", {
					requestId: "native-host-image",
					content,
				})
			).json(),
			checked = await (
				await post("/api/environments/drafts/preflight", {
					requestId: "native-host-image-check",
					id: staged.id,
					revision: staged.revision,
					digest: staged.digest,
				})
			).json();
		expect(checked.schemaAccepted).toBe(true);
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
	} finally {
		host.stop();
	}
	fs.writeFileSync(
		input,
		`${script}\n# changed source requires explicit reconciliation\n`,
	);
	const refused = path.join(root, "host-image-changed");
	expect(preview(refused).exitCode).toBe(0);
	const changed = JSON.parse(
		fs.readFileSync(path.join(refused, "environments.json"), "utf8"),
	);
	expect(
		changed.projects[0].targets.some(
			(target: { id: string }) =>
				target.id === "build-host-image" || target.id === "build-shell",
		),
	).toBe(false);
	expect(changed.projects[0].defaults?.build).toBeUndefined();
	expect(fs.existsSync(marker)).toBe(false);
	expect(
		fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
	).toBe(base);
}, 15000);

test("reviewed collector source migrates to native live TLS binding without receiver literals/references or legacy dispatch; changed pipelines remain blocked", async () => {
	const { app, config } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.chmodSync(config.stateDir, 0o700);
	});
	const root = path.dirname(config.configDir),
		source = path.join(root, "v1-telemetry"),
		guard = path.join(root, "tool-guards"),
		marker = path.join(root, "unexpected-workload");
	for (const directory of [
		"apps/build",
		"apps/compose",
		"apps/run",
		"apps/defaults",
		"infrastructure/compose",
	])
		fs.mkdirSync(path.join(source, directory), { recursive: true });
	fs.mkdirSync(guard);
	for (const name of ["docker", "podman", "mvn", "java", "helm", "kubectl"])
		fs.writeFileSync(
			path.join(guard, name),
			`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(99);\n`,
			{ mode: 0o700 },
		);
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ profiles: {}, repositories: config.repositories }),
	);
	const base = JSON.stringify({
		version: 1,
		projects: [
			{
				id: "grid-allocation-backend",
				kind: "app",
				repository: config.repositories[0],
				targets: [
					{
						id: "placeholder",
						action: "build",
						runtime: "shell",
						command: "echo placeholder",
					},
				],
			},
		],
	});
	fs.writeFileSync(path.join(config.configDir, "environments.json"), base);
	fs.writeFileSync(
		path.join(source, "apps/defaults/grid-allocation-backend.json"),
		JSON.stringify({ run: "docker" }),
	);
	const collectorConfig = fs.readFileSync(
		path.join(import.meta.dir, "fixtures/grid-otel-collector-config.txt"),
		"utf8",
	);
	const document = {
		services: {
			"grid-allocation-backend": {
				image: "fixture:latest",
				environment: {
					OTEL_SERVICE_NAME: `\${AC_OTEL_SERVICE_NAME:-grid-allocation-backend}`,
					OTEL_RESOURCE_ATTRIBUTES: `\${AC_OTEL_RESOURCE_ATTRIBUTES:-ac.app=grid-allocation-backend}`,
					OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
					OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
				},
			},
			"otel-collector": {
				image: "otel/opentelemetry-collector-contrib:0.162.0",
				command: ["--config=env:OTEL_COLLECTOR_CONFIG"],
				extra_hosts: ["host.docker.internal:host-gateway"],
				environment: {
					AC_OTEL_ENDPOINT: `\${AC_OTEL_ENDPOINT:-http://host.docker.internal:4318}`,
					OTEL_COLLECTOR_CONFIG: collectorConfig,
				},
			},
		},
	};
	const input = path.join(
		source,
		"apps/compose/grid-allocation-backend-compose.yml",
	);
	fs.writeFileSync(input, Bun.YAML.stringify(document));
	const preview = (directory: string) =>
		Bun.spawnSync(
			[
				process.execPath,
				path.join(
					import.meta.dir,
					"../scripts/preview-environment-migration.ts",
				),
				"--source-config",
				source,
				"--current-config",
				config.configDir,
				"--output",
				directory,
				"--socket",
				path.join(config.stateDir, "never-contacted.sock"),
			],
			{ stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: guard } },
		);
	const output = path.join(root, "telemetry-preview");
	expect(preview(output).exitCode).toBe(0);
	const content = fs.readFileSync(
			path.join(output, "environments.json"),
			"utf8",
		),
		converted = JSON.parse(content),
		project = converted.projects[0],
		target = project.targets.find(
			(target: { id: string }) => target.id === "run-compose-default",
		);
	expect(target.telemetry).toEqual({
		protocol: "otlp-http-json",
		listen: "0.0.0.0:0",
		collectorService: "otel-collector",
		transport: "tls-host-gateway-v1",
	});
	expect(project.defaults.run).toBe("run-compose-default");
	expect(content).not.toContain("AC_OTEL_ENDPOINT");
	expect(content).not.toContain("OTEL_COLLECTOR_CONFIG:");
	expect(content).not.toContain("http://host.docker.internal:4318");
	expect(content).not.toContain("AC_OTEL_RESOURCE_ATTRIBUTES");
	const host = serve(app);
	try {
		const post = client(host),
			staged = await (
				await post("/api/environments/drafts", {
					requestId: "native-telemetry",
					content,
				})
			).json();
		const checked = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "native-telemetry-check",
				id: staged.id,
				revision: staged.revision,
				digest: staged.digest,
				validateStagedCandidate: true,
			})
		).json();
		expect(checked.accepted).toBe(true);
		expect(checked.publicationAllowed).toBe(false);
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
	} finally {
		host.stop();
	}
	document.services["otel-collector"].environment.OTEL_COLLECTOR_CONFIG +=
		"\n# changed pipeline must not be interpreted by filename alone\n";
	fs.writeFileSync(input, Bun.YAML.stringify(document));
	const refused = path.join(root, "telemetry-changed");
	expect(preview(refused).exitCode).toBe(0);
	const changed = JSON.parse(
		fs.readFileSync(path.join(refused, "environments.json"), "utf8"),
	);
	expect(
		changed.projects[0].targets.some(
			(target: { id: string }) => target.id === "run-compose-default",
		),
	).toBe(false);
	expect(changed.projects[0].defaults?.run).toBeUndefined();
	expect(fs.existsSync(marker)).toBe(false);
	expect(
		fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
	).toBe(base);
}, 15000);

test("v1 Helm chart discovery converts to frozen-chart fresh releases with v1 identity unless overridden", async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		fs.chmodSync(config.stateDir, 0o700);
	});
	const root = path.dirname(config.configDir),
		source = path.join(root, "v1-source"),
		repo = config.repositories[0] ?? "";
	for (const directory of ["apps/build", "apps/compose", "apps/run"])
		fs.mkdirSync(path.join(source, directory), { recursive: true });
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ profiles: {}, repositories: config.repositories }),
	);
	for (const [chart, extra] of [
		[path.join(repo, "chart"), ""],
		[path.join(repo, "charts", "api-chart"), ""],
		[
			path.join(repo, "charts", "hooked-chart"),
			"metadata:\n  annotations:\n    helm.sh/hook: pre-install\n",
		],
	] as const) {
		fs.mkdirSync(path.join(chart, "templates"), { recursive: true });
		fs.writeFileSync(
			path.join(chart, "Chart.yaml"),
			"apiVersion: v2\nname: fixture\nversion: 0.1.0\n",
		);
		fs.writeFileSync(path.join(chart, "values.yaml"), "stage: local\n");
		fs.writeFileSync(
			path.join(chart, "templates", "cm.yaml"),
			`apiVersion: v1\nkind: ConfigMap\n${extra}`,
		);
	}
	const base = JSON.stringify({
		version: 1,
		projects: [{ id: "demo", kind: "app", repository: repo, targets: [] }],
	});
	fs.writeFileSync(path.join(config.configDir, "environments.json"), base);
	const run = (output: string, extra: string[]) =>
		Bun.spawnSync(
			[
				process.execPath,
				path.join(
					import.meta.dir,
					"../scripts/preview-environment-migration.ts",
				),
				"--source-config",
				source,
				"--current-config",
				config.configDir,
				"--output",
				path.join(root, output),
				"--socket",
				path.join(config.stateDir, "never-contacted.sock"),
				...extra,
			],
			{ stdout: "pipe", stderr: "pipe", cwd: repo },
		);
	expect(run("partial", ["--helm-cluster"]).exitCode).not.toBe(0);
	const implicitRun = run("implicit", []);
	expect(implicitRun.stderr.toString()).toBe("");
	expect(implicitRun.exitCode).toBe(0);
	const implicit = JSON.parse(
		fs.readFileSync(path.join(root, "implicit", "environments.json"), "utf8"),
	);
	expect(implicit.projects[0].targets[0].kubernetes).toMatchObject({
		cluster: "devenv",
		namespace: "default",
		helm: { chart: "chart", release: "demo" },
	});
	const chartRows = (report: { rows: { source: string }[] }) =>
		report.rows.filter((row) => row.source.endsWith("Chart.yaml"));
	expect(
		run("explicit", ["--helm-cluster", "local", "--helm-namespace", "fixtures"])
			.exitCode,
	).toBe(0);
	const report = JSON.parse(
			fs.readFileSync(path.join(root, "explicit", "report.json"), "utf8"),
		),
		content = fs.readFileSync(
			path.join(root, "explicit", "environments.json"),
			"utf8",
		);
	expect(chartRows(report)).toEqual([
		expect.objectContaining({
			app: "demo",
			target: "run-helm-local",
			status: "candidate",
		}),
		expect.objectContaining({
			app: "demo",
			target: "run-helm-api",
			status: "candidate",
		}),
		expect.objectContaining({
			app: "demo",
			source: "repository:demo/charts/hooked-chart/Chart.yaml",
			status: "blocked",
			reason: expect.stringContaining("Helm hooks"),
		}),
	]);
	const demo = JSON.parse(content).projects[0];
	expect(
		demo.targets.map((target: { kubernetes: unknown }) => target.kubernetes),
	).toEqual([
		{
			cluster: "local",
			namespace: "fixtures",
			workload: "helm-release-v1",
			helm: { chart: "chart", release: "demo" },
		},
		{
			cluster: "local",
			namespace: "fixtures",
			workload: "helm-release-v1",
			helm: { chart: path.join("charts", "api-chart"), release: "demo-api" },
		},
	]);
	expect(demo.targets).toHaveLength(2);
	expect(report.fullParityArchived).toBe(false);
	expect(
		fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
	).toBe(base);
	const host = serve(app);
	try {
		const post = client(host),
			staged = await (
				await post("/api/environments/drafts", {
					requestId: "helm-migration-preview",
					content,
				})
			).json();
		const checked = await (
			await post("/api/environments/drafts/preflight", {
				requestId: "helm-migration-check",
				id: staged.id,
				revision: staged.revision,
				digest: staged.digest,
			})
		).json();
		expect(checked.schemaAccepted).toBe(true);
		expect((await app.snapshot()).tasks).toHaveLength(0);
	} finally {
		await host.stop();
	}
}, 30000);
