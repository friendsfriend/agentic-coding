import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "../../src/workflow/runtime/store.ts";

const data: unknown = workerData;
const root =
	typeof data === "object" &&
	data !== null &&
	"root" in data &&
	typeof data.root === "string"
		? data.root
		: process.argv[2];
if (!root) throw new Error("An isolated repository fixture is required.");
const id =
	typeof data === "object" &&
	data !== null &&
	"id" in data &&
	typeof data.id === "string"
		? data.id
		: "compiled";
const db = openStore(root);
try {
	db.exec(
		"CREATE TABLE IF NOT EXISTS secure_worker_probe(value TEXT NOT NULL)",
	);
	db.query("INSERT INTO secure_worker_probe VALUES (?)").run(id);
	if (
		db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
			?.integrity_check !== "ok"
	)
		throw new Error("Native smoke integrity check failed.");
} finally {
	db.close();
}
parentPort?.postMessage("ok");
parentPort?.close();
