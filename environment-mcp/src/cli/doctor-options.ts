import path from "node:path";

export function parseDoctorOptions(args: string[]) {
	if (args[0] !== "--doctor") throw new Error("Explicit doctor mode required");
	const values = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (!key || !value || key !== "--config-dir" || values.has(key))
			throw new Error("Invalid doctor option");
		values.set(key, value);
	}
	const configDir = values.get("--config-dir");
	if (!configDir || !path.isAbsolute(configDir))
		throw new Error("Doctor requires an absolute config directory");
	return { configDir };
}
