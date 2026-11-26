import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureHelmChart } from "../src/configuration/helm-chart.ts";
import type { Executable } from "../src/domain/execution.ts";
import { rewriteWorktreeExecutable } from "../src/services/execution-service.ts";

test("worktrees rewrite compose, container and helm identities", () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "mcp-worktree-exec-")),
	);
	const repository = path.join(root, "repo");
	const linked = path.join(root, "linked");
	fs.mkdirSync(repository);
	fs.mkdirSync(linked);
	try {
		fs.writeFileSync(path.join(repository, "compose.yaml"), "services: {}\n");
		fs.writeFileSync(path.join(linked, "compose.yaml"), "services: {}\n");
		fs.writeFileSync(path.join(root, "outside.yaml"), "services: {}\n");
		const chart = path.join("chart");
		for (const base of [repository, linked]) {
			fs.mkdirSync(path.join(base, chart, "templates"), { recursive: true });
			fs.writeFileSync(
				path.join(base, chart, "Chart.yaml"),
				"apiVersion: v2\nname: fixture\nversion: 0.1.0\n",
			);
			fs.writeFileSync(
				path.join(base, chart, "templates", "config.yaml"),
				`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\ndata:\n  value: ${base === repository ? "main" : "worktree"}\n`,
			);
		}

		const compose = {
			kind: "compose",
			provider: "docker",
			socket: "/fixture/docker.sock",
			file: path.join(repository, "compose.yaml"),
			project: "fixture",
			services: ["api"],
			envRefs: {},
			serviceEnvRefs: {},
			timeoutSec: 30,
		} as unknown as Executable;
		rewriteWorktreeExecutable(compose, repository, linked);
		if (compose.kind !== "compose") throw new Error("not compose");
		expect(compose.file).toBe(
			fs.realpathSync(path.join(linked, "compose.yaml")),
		);
		expect(compose.project).toMatch(/^fixture-wt-[a-f0-9]{8}$/);

		const outside = {
			...compose,
			file: path.join(root, "outside.yaml"),
			project: "fixture",
		} as unknown as Executable;
		expect(() =>
			rewriteWorktreeExecutable(outside, repository, linked),
		).toThrow("worktree-unsupported");

		const container = {
			kind: "container-run",
			provider: "docker",
			socket: "/fixture/docker.sock",
			image: "fixture:latest",
			name: "environment-mcp-api-dev",
			ports: [],
			env: {},
			envRefs: {},
			readiness: "running",
			timeoutSec: 30,
		} as unknown as Executable;
		rewriteWorktreeExecutable(container, repository, linked);
		if (container.kind !== "container-run") throw new Error("not container");
		expect(container.name).toMatch(/^environment-mcp-api-dev-wt-[a-f0-9]{8}$/);

		const mainChart = captureHelmChart(repository, {
			chart,
			release: "fixture",
			values: [],
			setString: {},
		});
		const helm = {
			kind: "helm-release",
			cluster: "devenv",
			clusterDigest: "a".repeat(64),
			namespace: "default",
			release: "fixture",
			chart: mainChart.root,
			chartDigest: mainChart.digest,
			values: [],
			setString: {},
			timeoutSec: 30,
		} as unknown as Executable;
		rewriteWorktreeExecutable(helm, repository, linked);
		if (helm.kind !== "helm-release") throw new Error("not helm");
		const linkedChart = captureHelmChart(linked, {
			chart,
			release: "fixture",
			values: [],
			setString: {},
		});
		expect(helm.chart).toBe(linkedChart.root);
		expect(helm.chartDigest).toBe(linkedChart.digest);
		expect(helm.release).toMatch(/^fixture-wt-[a-f0-9]{8}$/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
