import type { DurableHost } from "../../src/agent-host/host.ts";

// These host-unit fixtures exercise telemetry/compaction/session binding AFTER
// the trusted native launch boundary. They do not model IPC authorization.
// Keep workflow metadata (including its run id) intact rather than laundering
// managed runs into legacy runs. workflow-managed-launch.test.ts exercises the
// actual server verification and refuses unfenced ensure/submit requests.
export function ensureFixtureRun(
	host: DurableHost,
	input: Parameters<DurableHost["ensureRun"]>[0],
) {
	return host.ensureRun(input, true);
}
export function submitFixtureRun(
	host: DurableHost,
	runId: string,
	text: string,
	requestId: string,
	whenBusy = "followUp",
) {
	return host.submit(runId, text, requestId, whenBusy, true);
}
