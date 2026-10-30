import { afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import {
	clearEnvironmentServer,
	environmentServer,
	publishEnvironmentServer,
} from "../../src/agent-host/environment-capability.ts";
import type { DurableHost, EnsureRunInput } from "../../src/agent-host/host.ts";
import { hostLayout } from "../../src/agent-host/layout.ts";
import type { LaunchPermit } from "../../src/contracts/launch.ts";
import { parseRunEnvFile } from "../../src/workflow/run-env.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const fixtures = new WeakMap<DurableHost, Map<string, LaunchPermit>>();
let revision = 0;

/** Host metadata/compaction tests don't exercise engine launch authority. Use a
 * fake authenticated verifier, but the REAL host admission/fence transaction.
 * Only its initial assignment submission is stubbed: the test itself supplies
 * every faux-provider turn, without a hidden model call during fixture setup.
 * Managed launch integration/refusal coverage lives in workflow-managed-launch.
 */
export async function ensureAdmittedFixtureRun(
	host: DurableHost,
	input: EnsureRunInput,
	hostRoot = hostLayout(input.cwd).root,
): Promise<{ conversationId: string }> {
	const env = parseRunEnvFile(fs.readFileSync(input.runEnvPath, "utf8"));
	if (!env.HERDR_WORKFLOW_ID) return host.ensureRun(input);
	let permits = fixtures.get(host);
	if (!permits) {
		permits = new Map();
		fixtures.set(host, permits);
		const issued = permits;
		const previous = environmentServer();
		const token = crypto.randomUUID();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.headers.get("authorization") !== `Bearer ${token}`)
					return new Response(null, { status: 403 });
				const claim = (await request.json()) as { runId: string };
				const permit = issued.get(claim.runId);
				return permit
					? Response.json(permit)
					: new Response(null, { status: 409 });
			},
		});
		publishEnvironmentServer({ url: server.url.toString(), token });
		const submit = host.submit.bind(host);
		const stub = spyOn(host, "submit").mockImplementation((...args) =>
			args[2] === issued.get(args[0])?.requestId
				? Promise.resolve({ submissionId: "fixture-initial-assignment" })
				: submit(...args),
		);
		cleanups.push(() => {
			stub.mockRestore();
			server.stop(true);
			clearEnvironmentServer(token);
			if (previous) publishEnvironmentServer(previous);
			fixtures.delete(host);
		});
	}
	const permit: LaunchPermit = {
		workflowId: env.HERDR_WORKFLOW_ID,
		runId: input.runId,
		stepId: env.HERDR_STEP_ID ?? "core.implementation",
		role: env.HERDR_ROLE ?? "worker",
		generation: Number(env.HERDR_RUN_GENERATION ?? 1),
		attempt: 1,
		revision: ++revision,
		claimAttempt: 1,
		requestId: `fixture-initial-assignment:${input.runId}`,
		leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		name: input.name,
		cwd: input.cwd,
		runEnvPath: input.runEnvPath,
		hostRoot,
		toolPolicy: input.toolPolicy === "read-only" ? "read-only" : "default",
		...(input.model ? { model: input.model } : {}),
	};
	permits.set(input.runId, permit);
	return host.admitWorkflowRun({
		...input,
		requestId: permit.requestId,
		type: "admitWorkflowRun",
		runId: input.runId,
		text: "fixture assignment",
		claim: {
			repo: input.cwd,
			workflowId: permit.workflowId,
			runId: input.runId,
			effectId: `fixture-launch:${input.runId}`,
			lease: "fixture-lease",
		},
	});
}
