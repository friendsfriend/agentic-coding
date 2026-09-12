import { expect, test } from "bun:test";
import type { ActionRun } from "@devenv/types";
import { actionTreeCopyText } from "./action-run-copy";

test("copies action node with complete descendant tree and command logs", () => {
	const run: ActionRun = {
		id: "k8s-local",
		title: "Start Kubernetes Local",
		action: "run",
		targetLabel: "[kubernetes] Kubernetes Local (kind) (k8s-local)",
		status: "failed",
		steps: [
			{
				id: "root",
				label: "Start application: k8s-local",
				status: "failed",
				commands: [
					{
						id: "root-command",
						command: "kind get clusters",
						status: "failed",
						stdout: "no cluster\n",
						stderr: "",
						error: "cluster unavailable",
						exitCode: 1,
					},
				],
			},
			{
				id: "postgres",
				parentId: "root",
				label: "Start dependency: postgres-k8s",
				status: "failed",
				commands: [
					{
						id: "postgres-command",
						command: "kubectl apply -f postgres.yaml",
						status: "failed",
						stdout: "",
						stderr: "apply failed\n",
						error: "apply failed",
						exitCode: 1,
					},
				],
			},
			{
				id: "run-1",
				parentId: "postgres",
				label: "Run application command",
				status: "completed",
				commands: [
					{
						id: "run-1-command",
						command: "helm install postgres",
						status: "completed",
						stdout: "installed\n",
						stderr: "",
						exitCode: 0,
					},
				],
			},
			{
				id: "run-2",
				parentId: "root",
				label: "Run application command",
				status: "completed",
				commands: [
					{
						id: "run-2-command",
						command: "kubectl wait",
						status: "completed",
						stdout: "ready\n",
						stderr: "",
						exitCode: 0,
					},
				],
			},
		],
	};

	const copied = actionTreeCopyText(
		{
			key: "action:k8s-local",
			kind: "action",
			run,
			depth: 0,
			hasChildren: true,
		},
		() => "",
	);

	expect(
		copied,
	).toBe(`▾ ✗ Start [kubernetes] Kubernetes Local (kind) (k8s-local)

$ kind get clusters
no cluster
[exit 1] cluster unavailable

    ▾ ✗ Start dependency: postgres-k8s

$ kubectl apply -f postgres.yaml
apply failed
[exit 1] apply failed

        ✓ Run application command

$ helm install postgres
installed
[exit 0]

    ✓ Run application command

$ kubectl wait
ready
[exit 0]`);
});

test("copies shared references without duplicating canonical command output", () => {
	const run: ActionRun = {
		id: "shared",
		title: "Run app",
		action: "run",
		status: "completed",
		steps: [
			{
				id: "canonical",
				label: "Start dependency: db",
				status: "completed",
				outcome: "executed",
				commands: [
					{
						id: "command",
						command: "podman start db",
						status: "completed",
						stdout: "db\n",
						stderr: "",
						exitCode: 0,
					},
				],
			},
			{
				id: "reference",
				label: "Start dependency: db",
				status: "completed",
				sharedReference: true,
				canonicalId: "canonical",
				outcome: "executed",
				commands: [],
			},
			{
				id: "ready",
				label: "Start dependency: cache",
				status: "completed",
				outcome: "already-running",
				commands: [],
			},
		],
	};
	const copied = actionTreeCopyText(
		{ key: "action:shared", kind: "action", run, depth: 0, hasChildren: true },
		() => "",
	);
	expect(copied.match(/\$ podman start db/g)?.length).toBe(1);
	expect(copied).toContain("↳ Start dependency: db (shared)");
	expect(copied).toContain("[shared execution: canonical]");
	expect(copied).toContain("Start dependency: cache (already running)");
});

test("copies selected step and all descendants even when collapsed", () => {
	const run: ActionRun = {
		id: "r",
		title: "Run app",
		action: "run",
		status: "completed",
		steps: [
			{
				id: "parent",
				label: "Start dependency: db",
				status: "completed",
				collapsed: true,
				commands: [],
			},
			{
				id: "child",
				parentId: "parent",
				label: "Start containers",
				status: "completed",
				commands: [
					{
						id: "child-command",
						command: "podman-compose up -d",
						status: "completed",
						stdout: "",
						stderr: "",
						exitCode: 0,
					},
				],
			},
		],
	};
	const copied = actionTreeCopyText(
		{
			key: "step:r:parent",
			kind: "step",
			run,
			step: run.steps[0],
			depth: 1,
			hasChildren: true,
		},
		() => "",
	);
	expect(copied).toContain("▾ ✓ Start dependency: db");
	expect(copied).toContain("    ✓ Start containers");
	expect(copied).toContain("$ podman-compose up -d");
});
