import path from "node:path";

export function parseSharedServerOptions(args: string[]) {
	if (args[0] !== "--serve") throw new Error("Explicit shared mode required");
	const values = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (
			!key ||
			!value ||
			![
				"--config-dir",
				"--state-dir",
				"--clients",
				"--provider-env-file",
				"--port",
				"--idle-timeout-sec",
			].includes(key) ||
			values.has(key)
		)
			throw new Error("Invalid shared server option");
		values.set(key, value);
	}
	const configDir = values.get("--config-dir"),
		directory = values.get("--state-dir"),
		clients = values.get("--clients"),
		providerEnvFile = values.get("--provider-env-file");
	if (
		!configDir ||
		!directory ||
		!clients ||
		![configDir, directory, clients].every(path.isAbsolute) ||
		(providerEnvFile !== undefined && !path.isAbsolute(providerEnvFile))
	)
		throw new Error("Explicit absolute paths required");
	const port = Number(values.get("--port") ?? 0),
		idleTimeoutSec = Number(values.get("--idle-timeout-sec") ?? 0);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("Invalid shared server port");
	if (
		!Number.isInteger(idleTimeoutSec) ||
		idleTimeoutSec < 0 ||
		idleTimeoutSec > 86_400
	)
		throw new Error("Invalid idle timeout");
	return {
		configDir,
		directory,
		clients,
		...(providerEnvFile ? { providerEnvFile } : {}),
		port,
		idleTimeoutSec,
	};
}
