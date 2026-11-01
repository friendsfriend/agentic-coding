import assert from "node:assert/strict";
import { SchedulingStore } from "../../src/server/scheduling/store.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Scheduling smoke requires a directory");
const store = SchedulingStore.open(directory);
const identity = store.identity;
assert.deepEqual(store.listJobs(), []);
store.close();
const reopened = SchedulingStore.open(directory);
try {
	assert.equal(reopened.identity, identity);
	assert.deepEqual(reopened.listJobs(), []);
} finally {
	reopened.close();
}
