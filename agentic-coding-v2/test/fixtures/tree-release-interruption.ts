// Disposable filesystem fault boundary: kill during temporary-tree deletion,
// after the deletion intent commits and before its completion is recorded.
// "before-removal" dies with the tree intact; "after-removal" dies after the
// removal itself. Only the exclusive temporary directory trips this boundary:
// the retained "trees/" root never contains the "tree-" temporary prefix.
// No model calls, engines or real projects.
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Config } from "../../src/config.ts";
import { Runtime } from "../../src/runtime.ts";
import { serve } from "../../src/server/index.ts";

const input = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as {
	config: Config;
	body: Record<string, unknown>;
	phase?: "before-removal" | "after-removal";
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
const remove = fs.rmSync;
fs.rmSync = (path, options) => {
	if (String(path).includes("/native/staging/tree-")) {
		if (input.phase !== "after-removal") process.kill(process.pid, "SIGKILL");
		remove(path, options);
		process.kill(process.pid, "SIGKILL");
	}
	return remove(path, options);
};
const host = serve(app),
	url = new URL(host.url);
const response = await fetch(
	new URL("/api/environments/drafts/tree/temporary-release", url),
	{
		method: "POST",
		headers: {
			Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input.body),
	},
);
console.error(`Unexpected release completion: ${response.status}`);
host.stop();
await app.close();
process.exit(2);
