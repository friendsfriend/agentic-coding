import fs from "node:fs";
import path from "node:path";

/** Compose does not discover the central config .env from an app checkout.
 * Pass only its path: Compose owns interpolation and shell-env precedence. */
export function composeFileArgs(
	sourcePath: string,
	configDir: string,
): string[] {
	const envFile = configDir ? path.join(configDir, ".env") : "";
	return [
		...(envFile && fs.existsSync(envFile) ? ["--env-file", envFile] : []),
		"-f",
		sourcePath,
	];
}
