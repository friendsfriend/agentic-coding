// Config-directory Kubernetes discovery and the drafts overlay
// (`add-environment-setup-workflow`, tasks 1.1-1.2): a k8s run config may live
// in the configuration directory with `$APP` resolving to the checkout, and a
// run held by a setup workflow resolves the drafts directory file by file
// before the live configuration.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	configDirEntries,
	discoverActionTargets,
	resolveConfigFilePath,
} from "../src/server/actions/discovery.ts";
import type { ActionTarget } from "../src/server/actions/targets.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function runTargets(context: {
	appIdent: string;
	localDir: string;
	configDir: string;
	configOverlay?: string;
}): ActionTarget[] {
	return discoverActionTargets({ ...context, action: "run" });
}

describe("config-directory Kubernetes run configs", () => {
	test("apps/kubernetes/<app>-<profile>.k8s.json becomes a run target with $APP in the checkout", () => {
		const configDir = tempDir("env-setup-k8s-");
		const checkout = tempDir("env-setup-checkout-");
		writeFile(
			path.join(configDir, "apps", "kubernetes", "shop-prod.k8s.json"),
			JSON.stringify({
				chart: {
					path: "$APP/deploy/helm",
					values: ["$CONFIG/templates/prod.yml"],
				},
				ports: [{ localPort: 18080, remotePort: 8080 }],
				wait: { timeoutSeconds: 30 },
			}),
		);
		const targets = runTargets({
			appIdent: "shop",
			localDir: checkout,
			configDir,
		});
		const kubernetes = targets.find(
			(target) => target.runtime === "kubernetes",
		);
		expect(kubernetes).toBeDefined();
		expect(kubernetes?.profile).toBe("prod");
		expect(kubernetes?.kubernetes?.chartPath).toBe(
			path.join(checkout, "deploy", "helm"),
		);
		expect(kubernetes?.kubernetes?.valuesFiles).toEqual([
			path.join(configDir, "templates", "prod.yml"),
		]);
		expect(kubernetes?.kubernetes?.release).toBe("shop-prod");
		expect(kubernetes?.kubernetes?.contextName).toBe("kind-devenv-prod");
		expect(kubernetes?.kubernetes?.ports?.[0]?.localPort).toBe(18080);
	});

	test("a checkout devenv.k8s.json still resolves under apps/k8s/<app>", () => {
		const configDir = tempDir("env-setup-k8s-");
		const checkout = tempDir("env-setup-checkout-");
		writeFile(
			path.join(configDir, "apps", "k8s", "shop", "devenv.k8s.json"),
			JSON.stringify({ targets: [{ chart: { path: "$APP/chart" } }] }),
		);
		const targets = runTargets({
			appIdent: "shop",
			localDir: checkout,
			configDir,
		});
		const kubernetes = targets.find(
			(target) => target.runtime === "kubernetes",
		);
		expect(kubernetes?.profile).toBe("local-1");
		expect(kubernetes?.kubernetes?.chartPath).toBe(
			path.join(checkout, "chart"),
		);
	});

	test("a config-directory file is only read for its own app", () => {
		const configDir = tempDir("env-setup-k8s-");
		const checkout = tempDir("env-setup-checkout-");
		writeFile(
			path.join(configDir, "apps", "kubernetes", "other-dev.k8s.json"),
			JSON.stringify({ chart: { path: "$APP/chart" } }),
		);
		const targets = runTargets({
			appIdent: "shop",
			localDir: checkout,
			configDir,
		});
		expect(targets.some((target) => target.runtime === "kubernetes")).toBe(
			false,
		);
	});
});

describe("drafts overlay", () => {
	test("a draft replaces a live definition and adds one without shadowing the rest", () => {
		const configDir = tempDir("env-setup-overlay-");
		const draftsDir = tempDir("env-setup-drafts-");
		const checkout = tempDir("env-setup-checkout-");
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"services:\n  shop:\n    image: live\n",
		);
		writeFile(
			path.join(configDir, "apps", "run", "shop-api.sh"),
			"echo live\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			"services:\n  shop:\n    image: draft\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "run", "shop-worker.sh"),
			"echo draft\n",
		);
		const targets = runTargets({
			appIdent: "shop",
			localDir: checkout,
			configDir,
			configOverlay: draftsDir,
		});
		const docker = targets.find((target) => target.runtime === "docker");
		expect(docker?.sourcePath).toBe(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
		);
		const added = targets.find(
			(target) => target.runtime === "shell" && target.profile === "worker",
		);
		expect(added?.sourcePath).toBe(
			path.join(draftsDir, "apps", "run", "shop-worker.sh"),
		);
		// The unrelated live definition is not shadowed by the drafts directory
		// existing: the overlay resolves per file, not per directory.
		const live = targets.find(
			(target) => target.runtime === "shell" && target.profile === "api",
		);
		expect(live?.sourcePath).toBe(
			path.join(configDir, "apps", "run", "shop-api.sh"),
		);
		expect(fs.readFileSync(docker?.sourcePath ?? "", "utf8")).toContain(
			"image: draft",
		);
	});

	test("config-relative resolution and directory listings prefer the overlay file", () => {
		const configDir = tempDir("env-setup-overlay-");
		const draftsDir = tempDir("env-setup-drafts-");
		writeFile(path.join(configDir, "apps", "run", "shop-api.sh"), "live\n");
		writeFile(path.join(draftsDir, "apps", "run", "shop-worker.sh"), "draft\n");
		const context = { configDir, configOverlay: draftsDir };
		expect(resolveConfigFilePath(context, "apps", "run", "shop-api.sh")).toBe(
			path.join(configDir, "apps", "run", "shop-api.sh"),
		);
		expect(
			configDirEntries(context, "apps", "run").map((entry) => entry.name),
		).toEqual(["shop-api.sh", "shop-worker.sh"]);
	});
});

// Round-2 finding: the overlay contributes plain files only, so a symbolic link
// an author leaves in the drafts tree can never become a run target the system
// executes without the approval view or the promotion ever seeing it.
test("a symbolic link in the drafts overlay does not resolve a target", () => {
	const configDir = tempDir("env-setup-overlay-");
	const draftsDir = tempDir("env-setup-drafts-");
	const checkout = tempDir("env-setup-checkout-");
	const outside = path.join(tempDir("env-setup-outside-"), "payload.sh");
	writeFile(outside, "echo payload\n");
	const linked = path.join(draftsDir, "apps", "run", "shop-linked.sh");
	fs.mkdirSync(path.dirname(linked), { recursive: true });
	fs.symlinkSync(outside, linked);
	const targets = runTargets({
		appIdent: "shop",
		localDir: checkout,
		configDir,
		configOverlay: draftsDir,
	});
	expect(targets.some((target) => target.sourcePath === linked)).toBe(false);
	expect(targets).toHaveLength(0);
	// The live configuration keeps its own behaviour for a real file.
	writeFile(path.join(configDir, "apps", "run", "shop-api.sh"), "echo api\n");
	const withLive = runTargets({
		appIdent: "shop",
		localDir: checkout,
		configDir,
		configOverlay: draftsDir,
	});
	expect(
		withLive.some((target) => target.sourcePath.endsWith("shop-api.sh")),
	).toBe(true);
});
