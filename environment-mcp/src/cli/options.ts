import path from "node:path";
import type { CatalogSourceOptions } from "../services/catalog-service.ts";

export function parseServerOptions(args: string[]): CatalogSourceOptions {
	let file: string | undefined;
	let configDir: string | undefined;
	let format: CatalogSourceOptions["format"] = "manifest";
	const repositories: string[] = [];
	let formatSet = false;
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index],
			value = args[index + 1];
		if (!value) throw new Error("Missing option value");
		if (key === "--config-dir") {
			if (
				configDir !== undefined ||
				file !== undefined ||
				!path.isAbsolute(value)
			)
				throw new Error("Invalid config directory");
			configDir = value;
		} else if (
			key === "--config" &&
			file === undefined &&
			configDir === undefined
		) {
			if (!path.isAbsolute(value))
				throw new Error("Absolute configuration path required");
			file = value;
		} else if (
			key === "--format" &&
			!formatSet &&
			["manifest", "v2-catalog"].includes(value)
		) {
			format = value as CatalogSourceOptions["format"];
			formatSet = true;
		} else if (key === "--repository" && path.isAbsolute(value))
			repositories.push(value);
		else throw new Error("Invalid option");
	}
	if (configDir !== undefined) {
		if (file !== undefined || formatSet)
			throw new Error("Invalid configuration mode");
		return {
			file: path.join(configDir, "environments.json"),
			format: "v2-config",
			repositories,
		};
	}
	if (!file || (format === "manifest" && repositories.length))
		throw new Error("Explicit configuration required");
	return { file, format, repositories };
}
