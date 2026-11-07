import { mkdir } from "node:fs/promises";
import solidPlugin from "@opentui/solid/bun-plugin";

await mkdir("dist", { recursive: true });
const result = await Bun.build({
	entrypoints: ["src/cli.ts"],
	target: "bun",
	outdir: "dist",
	naming: "agentic-coding-v2.js",
	plugins: [solidPlugin],
	// Keep native libraries and relative worker/font assets package-relative.
	// This JS bundle requires the installed OpenTUI runtime; it is not a portable executable.
	external: ["@opentui/core", "@opentui/core/*", "@opentui/core-*"],
});
if (!result.success) {
	for (const message of result.logs) console.error(message);
	process.exitCode = 1;
}
