import path from "node:path";
import { definitionProjectLimit } from "../environment/definition-limits.ts";

export function daemonOptions(args: string[]) {
	const values = new Map<string, string>();
	const repositories: string[] = [];
	if (args[0] !== "--serve") throw new Error("Expected explicit serve mode");
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error("Missing daemon option");
		if (key === "--repository") repositories.push(value);
		else if (
			[
				"--config-dir",
				"--state-dir",
				"--clients",
				"--port",
				"--operator-port",
			].includes(key) &&
			!values.has(key)
		)
			values.set(key, value);
		else throw new Error("Unknown or repeated daemon option");
	}
	const paths = ["--config-dir", "--state-dir", "--clients"].map((key) =>
		values.get(key),
	);
	if (
		paths.some((value) => !value || !path.isAbsolute(value)) ||
		!repositories.length ||
		repositories.length > definitionProjectLimit ||
		repositories.some((root) => !path.isAbsolute(root))
	)
		throw new Error("Daemon paths must be explicit and absolute");
	const port = Number(values.get("--port") ?? 0),
		operatorPort = Number(values.get("--operator-port") ?? 0);
	if (
		[port, operatorPort].some(
			(value) => !Number.isInteger(value) || value < 0 || value > 65535,
		)
	)
		throw new Error("Invalid daemon port");
	return {
		configDir: paths[0] ?? "",
		stateDir: paths[1] ?? "",
		clients: paths[2] ?? "",
		repositories,
		port,
		operatorPort,
	};
}
