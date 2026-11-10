// Registers an existing kind cluster as a native v2 cluster, like v1's implicit
// `kind-<name>` context. Developer-invoked only: it reads `kind get kubeconfig`
// (never creates a cluster), writes the inline credentials to private 0600
// files under CONFIG_DIR/clusters/<id>/, and adds or replaces one clusters.json
// entry listing the explicit repositories. No credential value is printed.
import fs from "node:fs";
import path from "node:path";
import { defaultConfigDir, object, text } from "../src/config.ts";

function option(name: string) {
	const args = process.argv.slice(2),
		at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}
const name = text(option("--name") ?? "devenv", "kind cluster name", 64),
	id = text(option("--id") ?? name, "cluster identifier", 64),
	configDir = path.resolve(option("--config-dir") ?? defaultConfigDir()),
	repositories = process.argv
		.slice(2)
		.flatMap((value, index, all) =>
			all[index - 1] === "--repository" ? [fs.realpathSync(value)] : [],
		);
if (!/^[a-z][a-z0-9-]*$/.test(id) || !/^[a-z0-9][a-z0-9.-]*$/.test(name))
	throw new Error("Invalid kind cluster name or identifier");
if (!repositories.length)
	throw new Error("At least one explicit --repository is required");
const configured = object(
	JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")),
);
const authorized = (configured.repositories as string[]).map((repository) =>
	fs.realpathSync(repository),
);
if (repositories.some((repository) => !authorized.includes(repository)))
	throw new Error("Every --repository must be authorized in config.json");
const result = Bun.spawnSync(["kind", "get", "kubeconfig", "--name", name], {
	stdout: "pipe",
	stderr: "pipe",
});
if (result.exitCode !== 0)
	throw new Error(
		`kind cluster ${name} is not available; create it first (clusters are never created here)`,
	);
const source = object(Bun.YAML.parse(result.stdout.toString()));
const context = `kind-${name}`,
	pick = (list: unknown, key: string) => {
		if (!Array.isArray(list)) throw new Error("Unexpected kind kubeconfig");
		const entry = list.map(object).find((item) => item.name === context);
		if (!entry) throw new Error("kind kubeconfig lacks its kind- context");
		return object(entry[key]);
	};
const cluster = pick(source.clusters, "cluster"),
	user = pick(source.users, "user"),
	server = new URL(text(cluster.server, "kind server", 4096));
if (
	server.protocol !== "https:" ||
	!["127.0.0.1", "[::1]"].includes(server.hostname)
)
	throw new Error("kind API server must be HTTPS on a loopback address");
const directory = path.join(configDir, "clusters", id);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
const write = (file: string, base64: unknown) => {
	const target = path.join(directory, file);
	fs.rmSync(target, { force: true });
	fs.writeFileSync(
		target,
		Buffer.from(text(base64, "kind credential", 65536), "base64"),
		{ mode: 0o600, flag: "wx" },
	);
	return file;
};
const kubeconfig = {
	apiVersion: "v1",
	kind: "Config",
	clusters: [
		{
			name: context,
			cluster: {
				server: server.origin,
				"certificate-authority": write(
					"ca.crt",
					cluster["certificate-authority-data"],
				),
			},
		},
	],
	contexts: [{ name: context, context: { cluster: context, user: context } }],
	users: [
		{
			name: context,
			user: {
				"client-certificate": write(
					"client.crt",
					user["client-certificate-data"],
				),
				"client-key": write("client.key", user["client-key-data"]),
			},
		},
	],
};
const kubeconfigFile = path.join(directory, "kubeconfig.json");
fs.rmSync(kubeconfigFile, { force: true });
fs.writeFileSync(kubeconfigFile, JSON.stringify(kubeconfig, null, 2), {
	mode: 0o600,
	flag: "wx",
});
const clustersFile = path.join(configDir, "clusters.json"),
	document = fs.existsSync(clustersFile)
		? object(JSON.parse(fs.readFileSync(clustersFile, "utf8")))
		: { version: 1, clusters: [] };
const clusters = (document.clusters as Record<string, unknown>[]).filter(
	(entry) => entry.id !== id,
);
clusters.push({
	id,
	repositories,
	kubeconfig: path.relative(configDir, kubeconfigFile),
	context,
	environment: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
});
const temporary = `${clustersFile}.${process.pid}`;
fs.writeFileSync(
	temporary,
	`${JSON.stringify({ version: 1, clusters }, null, 2)}\n`,
	{ mode: 0o600, flag: "wx" },
);
fs.renameSync(temporary, clustersFile);
console.log(
	JSON.stringify({
		cluster: id,
		context,
		server: server.origin,
		repositories: repositories.length,
		credentialValuesPrinted: false,
	}),
);
