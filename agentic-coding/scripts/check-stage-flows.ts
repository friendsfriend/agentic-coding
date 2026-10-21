// Checked-in compiled-flow gate (`add-stage-flow-replay`, task 2.2). It validates
// every `stage-flows/*/flow.json` against the current block registry and verifies
// the sidecar spec hash. It never needs a browser or an approved run plan. It also
// validates every checked-in `stage-flows/*.suite.json` against the same flow
// registry (task 9.1/9.2's referential and input-schema checks).

import path from "node:path";
import {
	flowManifestIssues,
	readFlowRegistry,
} from "../src/stage-blocks/flow-registry.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import {
	readSuiteRegistry,
	suiteRegistryIssues,
} from "../src/stage-blocks/suite.ts";

const root = path.resolve(import.meta.dir, "..");
const registry = readFlowRegistry(root);
const issues = [...registry.issues];
for (const entry of registry.entries)
	for (const issue of flowManifestIssues(entry.manifest, stageBlockRegistry))
		issues.push(issue);
const suites = readSuiteRegistry(root);
for (const issue of suites.issues) issues.push(issue);
for (const entry of suites.entries)
	for (const issue of suiteRegistryIssues(entry.manifest, registry.entries))
		issues.push(issue);
if (issues.length > 0) {
	for (const issue of issues)
		console.error(
			`${issue.code}${issue.field === undefined ? "" : ` ${issue.field}`}: ${issue.message}`,
		);
	process.exit(1);
}
console.log(
	`stage flows are current (${registry.entries.length} checked-in flow${
		registry.entries.length === 1 ? "" : "s"
	}, ${suites.entries.length} checked-in suite${
		suites.entries.length === 1 ? "" : "s"
	})`,
);
