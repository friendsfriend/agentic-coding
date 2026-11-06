// Disposable filesystem fault boundary: kill the host after its retained-tree
// rename, before preflight completion. No model calls, engines or real projects.
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Config } from "../../src/config.ts";
import { Runtime } from "../../src/runtime.ts";
import { serve } from "../../src/server.ts";

const input = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as {
	config: Config;
	body: Record<string, unknown>;
};
const models = createModels();
models.setProvider(fauxProvider({ models: [{ id: "original" }] }).provider);
const app = await Runtime.open(
	input.config,
	models,
	await openNodeJsonlStorage(`${input.config.stateDir}/native`, context, {
		fsync: true,
	}),
);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
	rename(from, to);
	if (String(to).includes("/native/staging/trees/"))
		process.kill(process.pid, "SIGKILL");
};
const host = serve(app),
	url = new URL(host.url);
const response = await fetch(
	new URL("/api/environments/drafts/preflight", url),
	{
		method: "POST",
		headers: {
			Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input.body),
	},
);
console.error(`Unexpected preflight completion: ${response.status}`);
host.stop();
await app.close();
process.exit(2);
