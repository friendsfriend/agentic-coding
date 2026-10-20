// The server's start boundary forwards the stage of a stage test
// (`add-stage-test-launch`, task 2.1).
//
// Both launch surfaces — the dashboard form and the orchestrator's
// `start_workflow` — hand `stage` to the same start boundary. The two hops that
// carry it are the HTTP route (`handlers.startWorkflow`) and the dashboard
// operation (`startWorkflow` in `operations/observations.ts`), and a stage
// dropped at either one starts a stage test on no stage at all: the server would
// refuse the start (or, worse, the run would plan against nothing) while the
// form reported success. So the assertion is the stored workflow's own metadata,
// read back through the view the dashboard renders.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWorkflow as startWorkflowRequest } from "../src/server/handlers.ts";
import {
	disposeDashboardApplication,
	getWorkflowView,
	startArgs,
} from "../src/server/operations/engine.ts";
import { startWorkflow as startWorkflowOperation } from "../src/server/operations/observations.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { stageTestWorkflowTarget } from "../src/workflow/runtime/targets.ts";

/** Everything one configured root owns: its directory and the environment
 * restore that follows it. */
interface StageRoot {
	directory: string;
	restore(): void;
}

let activeRoot: StageRoot | undefined;

afterEach(() => {
	disposeDashboardApplication();
	activeRoot?.restore();
	if (activeRoot)
		fs.rmSync(activeRoot.directory, { recursive: true, force: true });
	activeRoot = undefined;
});

function pools(stepIds: readonly string[]): Record<string, unknown[]> {
	return Object.fromEntries(
		stepIds.map((stepId) => [
			stepId,
			[{ label: "only", profile: "p", default: true }],
		]),
	);
}

/**
 * A private configuration root with one allow-listed stage and the preset the
 * start pins. Nothing is executed: the start only has to create the workflow and
 * keep the stage it was given.
 */
function configureStageRoot(): void {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-launch-start-"),
	);
	const wiki = path.join(directory, "wiki");
	fs.mkdirSync(wiki, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "config.json"),
		`${JSON.stringify({
			agents: {
				default_profile: "p",
				profiles: {
					p: {
						runtime: "pi-durable",
						executable: "/bin/true",
						capabilities: [
							"prompt",
							"run-environment",
							"observe",
							"vision",
							"shell",
							"edit",
						],
					},
				},
				presets: {
					fixed: {
						default_profile: "p",
						pools: pools(["stage.plan", "stage.execute", "core.wiki"]),
					},
				},
			},
			wiki: { root: wiki },
		})}\n`,
	);
	const defsDir = stagePaths(directory).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify({
			ident: "grid-int",
			displayName: "Grid integration",
			environment: "integration",
			system: "grid",
			access: "writable",
			apps: {
				web: {
					label: "Grid web",
					url: "https://grid.example.test/",
					kind: "ui",
				},
			},
		})}\n`,
	);
	const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
	const previousConfig = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.AGENTIC_CODING_CONFIG_DIR = directory;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	activeRoot = {
		directory,
		restore() {
			if (previousRoot === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
			if (previousConfig === undefined)
				delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previousConfig;
		},
	};
}

const TASK = "check the request status";

describe("a stage-test start keeps the stage it was given", () => {
	test("the start mapper forwards the stage", () => {
		const args = startArgs({
			repo: "",
			ticket: "",
			workflowId: "wf-stage-args",
			mode: "",
			workflowType: "stage-test",
			stage: "grid-int",
			task: TASK,
		});
		expect(args.stage).toBe("grid-int");
	});

	test("the dashboard operation and the HTTP route both keep it", async () => {
		configureStageRoot();
		await startWorkflowOperation({
			repo: "",
			ticket: "GRID-1",
			workflowId: "wf-stage-operation",
			mode: "",
			workflowType: "stage-test",
			preset: "fixed",
			stage: "grid-int",
			task: TASK,
		});
		const target = stageTestWorkflowTarget();
		const view = getWorkflowView(target, "wf-stage-operation");
		// The stage pins the system, the access marker and the ticket the plan and
		// the report read back: all of it comes from the request, not from a
		// default the boundary filled in.
		expect(view.stage).toBe("grid-int");
		expect(view.stageSystem).toBe("grid");
		expect(view.stageAccess).toBe("writable");
		expect(view.ticket).toBe("GRID-1");
		expect(view.task).toBe(TASK);
		// The route is the hop the orchestrator and the dashboard transport use.
		await startWorkflowRequest({
			repo: "",
			ticket: "GRID-2",
			workflowId: "wf-stage-route",
			mode: "",
			workflowType: "stage-test",
			preset: "fixed",
			stage: "grid-int",
			task: TASK,
		});
		expect(getWorkflowView(target, "wf-stage-route").stage).toBe("grid-int");
	});

	test("a stage outside the allow-list is refused before anything starts", async () => {
		configureStageRoot();
		await expect(
			startWorkflowRequest({
				repo: "",
				ticket: "",
				workflowId: "wf-stage-unknown",
				mode: "",
				workflowType: "stage-test",
				preset: "fixed",
				stage: "grid-nope",
				task: TASK,
			}),
		).rejects.toThrow(/not in the configured allow-list/);
	});
});
