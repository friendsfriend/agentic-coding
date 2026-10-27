import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

const workflowDir = process.env.AGENT_HOST_TEST_WORKFLOW_DIR;
const retryCapabilityIndex = process.argv.indexOf("--retry-capability-fd");
let retryCapability;
if (retryCapabilityIndex >= 0) {
	const descriptor = Number(process.argv[retryCapabilityIndex + 1]);
	const buffer = Buffer.alloc(128);
	try {
		const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
		const value = buffer.toString("utf8", 0, bytes);
		if (/^[a-f0-9]{64}$/.test(value)) retryCapability = value;
	} finally {
		try {
			fs.closeSync(descriptor);
		} catch {
			// No capability when the inherited pipe was unavailable.
		}
	}
}
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage([fauxText("completed")])]);

const recoveryPath = process.env.AGENT_HOST_TEST_RECOVERY_PATH;
if (process.env.AGENT_HOST_TEST_CRASH_ON_MODEL === "1") {
	const crash = () => {
		fs.appendFileSync(process.env.AGENT_HOST_TEST_CRASH_PATH, "crash\n");
		process.kill(process.pid, "SIGKILL");
	};
	faux.provider.stream = crash;
	faux.provider.streamSimple = crash;
} else if (recoveryPath) {
	const stream = faux.provider.stream.bind(faux.provider);
	const streamSimple = faux.provider.streamSimple.bind(faux.provider);
	const recordRecovery = () => fs.appendFileSync(recoveryPath, "resumed\n");
	faux.provider.stream = (...args) => {
		recordRecovery();
		return stream(...args);
	};
	faux.provider.streamSimple = (...args) => {
		recordRecovery();
		return streamSimple(...args);
	};
}

const models = createModels();
models.setProvider(faux.provider);
const host = await DurableHost.open({
	layout: hostLayout(workflowDir),
	settings: {},
	globalAgentDir: process.env.PI_CODING_AGENT_DIR,
	models,
	...(retryCapability ? { retryCapability } : {}),
});
await host.listen();

const runEnvPath = path.join(workflowDir, "run.env");
await host.ensureRun({
	runId: "native-restart-limit",
	cwd: workflowDir,
	runEnvPath,
	name: "native-restart-limit",
	toolPolicy: "default",
	model: "faux/faux-1",
});

const inspectRequestPath = process.env.AGENT_HOST_TEST_INSPECT_REQUEST_PATH;
const inspectResponsePath = process.env.AGENT_HOST_TEST_INSPECT_RESPONSE_PATH;
if (inspectRequestPath && inspectResponsePath) {
	let inspecting = false;
	const inspectRequests = setInterval(async () => {
		if (inspecting || !fs.existsSync(inspectRequestPath)) return;
		inspecting = true;
		try {
			const taskId = Number(fs.readFileSync(inspectRequestPath, "utf8"));
			fs.rmSync(inspectRequestPath, { force: true });
			const task = await host.harness.getTask(taskId, BACKGROUND_CONTEXT);
			fs.writeFileSync(
				inspectResponsePath,
				JSON.stringify({
					taskId: task ? String(taskId) : "",
					status: task?.state.status ?? "missing",
					restarts: task?.restarts ?? null,
					abortRequested: task?.abortRequested ?? null,
					reason: task?.state.status === "blocked" ? task.state.reason : "",
					outcome:
						task?.state.status === "terminal" ? task.state.outcome.status : "",
				}),
			);
		} catch {
			fs.writeFileSync(
				inspectResponsePath,
				JSON.stringify({ status: "failed" }),
			);
		} finally {
			inspecting = false;
		}
	}, 10);
	inspectRequests.unref();
}

const submittedPath = path.join(workflowDir, "submitted");
if (!fs.existsSync(submittedPath)) {
	// Write before admission because the provider can crash the process before
	// `submit` resolves. On reopen, the native task—not a duplicate request—is
	// responsible for continuing this same submission.
	fs.writeFileSync(submittedPath, "submitted");
	await host.submit("native-restart-limit", "trigger crash loop", "req-1");
}
