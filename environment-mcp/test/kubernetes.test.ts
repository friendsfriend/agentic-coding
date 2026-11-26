import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKubernetesAdapter } from "../src/adapters/process/kubernetes.ts";

test("kubernetes inspection is fixed, scoped and read-only", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kubernetes-")),
	);
	const repository = path.join(root, "repo");
	fs.mkdirSync(repository);
	const argsFile = path.join(root, "kubectl-args.txt");
	const script = path.join(root, "kubectl-fixture");
	fs.writeFileSync(
		script,
		`#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argsFile)}
case "$*" in
  *"get deployments,statefulsets,pods,services"*)
    printf '%s' '{"items":[{"kind":"Pod","metadata":{"name":"pod-a","namespace":"default","creationTimestamp":"2026-01-01T00:00:00Z"},"status":{"phase":"Running","containerStatuses":[{"name":"app","ready":true,"restartCount":1}]}}]}'
    ;;
  *"get events"*)
    printf '%s' '{"items":[{"type":"Warning","reason":"BackOff","involvedObject":{"kind":"Pod","name":"pod-a"},"message":"restarting","count":3,"lastTimestamp":"2026-01-01T00:00:00Z"}]}'
    ;;
  *"describe pod pod-a"*)
    printf 'Name: pod-a\\nStatus: Running\\n'
    ;;
  *"logs pod-a"*)
    printf 'line one\\nline two\\n'
    ;;
esac
`,
		{ mode: 0o755 },
	);
	const adapter = createKubernetesAdapter(root, [repository], {
		kubectl: script,
	});
	const signal = new AbortController().signal;
	try {
		expect(adapter.list([repository])).toEqual([
			{
				id: "devenv",
				context: "kind-devenv",
				repositories: [repository],
			},
		]);
		expect(adapter.list(["/other/repository"])).toEqual([]);
		const resources = await adapter.resources(
			[repository],
			"devenv",
			"default",
			signal,
		);
		expect(resources.items).toEqual([
			{
				kind: "Pod",
				name: "pod-a",
				status: "Running",
				ready: "1/1",
				restarts: 1,
				containers: ["app"],
				createdAt: "2026-01-01T00:00:00Z",
				age: expect.any(String),
			},
		]);
		expect(resources.output).toContain("Pod\tpod-a\t1/1\tRunning\t1");
		expect(resources.truncated).toBe(false);
		const events = await adapter.events(
			[repository],
			"devenv",
			"default",
			signal,
		);
		expect(events.events).toEqual([
			{
				type: "Warning",
				reason: "BackOff",
				object: "Pod/pod-a",
				message: "restarting",
				count: 3,
				lastTimestamp: "2026-01-01T00:00:00Z",
			},
		]);
		const describe = await adapter.describe(
			[repository],
			"devenv",
			"default",
			"pod",
			"pod-a",
			signal,
		);
		expect(describe.output).toContain("Name: pod-a");
		const logs = await adapter.podLogs(
			[repository],
			"devenv",
			"default",
			"pod-a",
			undefined,
			100,
			signal,
		);
		expect(logs.output).toContain("line one");
		const calls = fs.readFileSync(argsFile, "utf8");
		expect(calls).toContain(
			"--context kind-devenv --request-timeout=10s get deployments,statefulsets,pods,services --namespace default --output json",
		);
		expect(calls).toContain(
			"--context kind-devenv --request-timeout=10s get events --namespace default --sort-by=.lastTimestamp --output json",
		);
		expect(calls).toContain(
			"--context kind-devenv --request-timeout=10s describe pod pod-a --namespace default",
		);
		expect(calls).toContain(
			"--context kind-devenv --request-timeout=10s logs pod-a --namespace default --tail 100",
		);
		await expect(
			adapter.resources([repository], "devenv", "kube-system", signal),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		await expect(
			adapter.resources(["/other/repository"], "devenv", "default", signal),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		await expect(
			adapter.resources([repository], "missing", "default", signal),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		await expect(
			adapter.describe(
				[repository],
				"devenv",
				"default",
				"secret",
				"pod-a",
				signal,
			),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		await expect(
			adapter.describe(
				[repository],
				"devenv",
				"default",
				"pod",
				"--all",
				signal,
			),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		await expect(
			adapter.podLogs(
				[repository],
				"devenv",
				"default",
				"pod-a",
				undefined,
				0,
				signal,
			),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		const missing = createKubernetesAdapter(root, [repository], {
			kubectl: path.join(root, "missing-kubectl"),
		});
		await expect(
			missing.resources([repository], "devenv", "default", signal),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
		await expect(
			missing.events([repository], "devenv", "default", signal),
		).rejects.toMatchObject({ code: "kubernetes-cluster-unavailable" });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
