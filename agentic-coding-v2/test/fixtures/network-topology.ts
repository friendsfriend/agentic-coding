import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import { serveContainerFixture } from "./container-server.ts";
export const infrastructureServices = [
	"redis",
	"postgres",
	"mailpit",
	"activemq",
	"azurite",
	"playwright-server",
];
export const topologyEngineFile = (config: Config) =>
	path.join(config.configDir, "engine.json");
export const topologyDefinitions = (config: Config) =>
	path.join(config.configDir, "environments.json");
export function configureTopologyFixture(
	config: Config,
	provider: "docker" | "podman" = "docker",
) {
	fs.mkdirSync(config.configDir);
	fs.chmodSync(config.stateDir, 0o700);
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	for (const runtime of ["docker", "podman"])
		fs.writeFileSync(
			path.join(bin, runtime),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
	fs.writeFileSync(
		topologyEngineFile(config),
		JSON.stringify({ next: 1, containers: {}, history: [] }),
	);
	const engine = serveContainerFixture(topologyEngineFile(config));
	const edge = (app: string) => ({ app, target: "run" });
	const target = (id: string) => ({
		id: "run",
		action: "run",
		runtime: "compose",
		timeoutMs: 10000,
		environment: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: engine.socket,
		},
		...(id === "topology" ? {} : { prerequisites: [edge("topology")] }),
		compose: {
			file: "compose.native.yaml",
			provider,
			socket: engine.socket,
			network: "shared",
			...(id === "topology"
				? { networkOnly: true, source: "services: {}\n" }
				: {
						networkFrom: edge("topology"),
						source: `services:\n  ${id}:\n    image: fixture:latest\n    command: [serve]\n    healthcheck:\n      test: [CMD, 'true']\n`,
					}),
		},
	});
	const project = (id: string, kind: "infrastructure" | "app") => ({
		id,
		kind,
		repository: config.repositories[0],
		targets: [target(id)],
	});
	const alpha = project("alpha", "app"),
		beta = project("beta", "app");
	alpha.targets[0].prerequisites = [
		edge("topology"),
		...infrastructureServices.map(edge),
	];
	beta.targets[0].prerequisites = [edge("topology"), edge("postgres")];
	fs.writeFileSync(
		topologyDefinitions(config),
		JSON.stringify({
			version: 1,
			projects: [
				project("topology", "infrastructure"),
				...infrastructureServices.map((id) => project(id, "infrastructure")),
				alpha,
				beta,
			],
		}),
	);
	return engine;
}
