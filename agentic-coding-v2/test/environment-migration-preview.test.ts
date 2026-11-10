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
	expect(result.exitCode).toBe(0);
	const report = JSON.parse(
		fs.readFileSync(path.join(output, "report.json"), "utf8"),
	);
	expect(
		report.rows.filter((row: { status: string }) => row.status === "candidate"),
	).toHaveLength(2);
	expect(report.sources).toHaveLength(5);
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
