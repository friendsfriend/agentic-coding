import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../src/config.ts";
/** Disposable local client boundary: no kubeconfig credentials or live API calls. */
export function configureLocalCluster(
	config: Config,
	script: string,
	environment: Record<string, string> = {},
) {
	fs.mkdirSync(config.configDir);
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, "kubectl"),
		`#!${process.execPath}\n${script}`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		path.join(config.configDir, "local.json"),
		JSON.stringify({
			apiVersion: "v1",
			kind: "Config",
			clusters: [
				{ name: "fixture", cluster: { server: "https://127.0.0.1:6443" } },
			],
			contexts: [{ name: "explicit-fixture", context: { cluster: "fixture" } }],
			users: [],
		}),
	);
	fs.writeFileSync(
		path.join(config.configDir, "clusters.json"),
		JSON.stringify({
			version: 1,
			clusters: [
				{
					id: "local",
					repository: config.repositories[0],
					kubeconfig: "local.json",
					context: "explicit-fixture",
					environment: {
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						...environment,
					},
				},
			],
		}),
	);
}
