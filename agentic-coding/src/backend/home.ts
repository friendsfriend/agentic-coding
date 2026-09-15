// Environment home/configuration resolution (moved out of the retired
// managed-Go-backend boundary). Pure path resolution: the one executable and
// every subprocess it starts resolve the same directories through this module.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseEnvFile(filePath: string): Record<string, string> {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const vars: Record<string, string> = {};
		for (const raw of content.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const stripped = line.replace(/^export\s+/, "");
			const eq = stripped.indexOf("=");
			if (eq === -1) continue;
			const key = stripped.slice(0, eq).trim();
			let value = stripped
				.slice(eq + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			value = value.replace(/\$\{HOME\}|\$HOME/g, os.homedir());
			if (key) vars[key] = value;
		}
		return vars;
	} catch {
		return {};
	}
}

export function resolveConfigDir(): string {
	if (process.env.DEVENV_CONFIG_DIR) return process.env.DEVENV_CONFIG_DIR;
	return path.join(os.homedir(), ".config", "devenv");
}

export function resolveDevenvHome(): string {
	if (process.env.DEVENV_HOME) return process.env.DEVENV_HOME;
	const configDir = resolveConfigDir();
	const envVars = parseEnvFile(path.join(configDir, ".env"));
	if (envVars.DEVENV_HOME) return envVars.DEVENV_HOME;
	return path.join(os.homedir(), "devenv");
}
