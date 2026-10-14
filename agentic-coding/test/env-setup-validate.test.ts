// The env-setup validation gate (`add-environment-setup-workflow`, task 3.1):
// structural checks over the drafts and a real start of every drafted target,
// with the compiler and starter supplied as doubles.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionTarget } from "../src/server/actions/targets.ts";
import { setupDraftsDir } from "../src/server/environment/setup-drafts.ts";
import {
	composeHostPorts,
	declaredAppPorts,
	detectPortCollisions,
	referencesOtelVariables,
	setupVariables,
	validateSetupDrafts,
} from "../src/server/environment/setup-validate.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

const COMPOSE_WITH_OTEL = [
	"services:",
	"  shop:",
	"    image: shop:latest",
	"    ports:",
	'      - "8090:8080"',
	"    environment:",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolates the injected OTel variable
	"      OTEL_EXPORTER_OTLP_ENDPOINT: ${AC_OTEL_ENDPOINT}",
	"",
].join("\n");

function context(options: {
	configDir: string;
	draftsDir: string;
	checkoutDir: string;
	startTarget?: (
		target: ActionTarget,
	) => Promise<{ ready: boolean; detail?: string }>;
	otherAppPorts?: Map<number, string>;
	envFileVariables?: Map<string, string>;
	processEnv?: Record<string, string | undefined>;
}) {
	return {
		configDir: options.configDir,
		draftsDir: options.draftsDir,
		appIdent: "shop",
		checkoutDir: options.checkoutDir,
		startTarget:
			options.startTarget ?? (async () => ({ ready: true as const })),
		compileTarget: async () => {},
		otherAppPorts: () => options.otherAppPorts ?? new Map<number, string>(),
		envFileVariables: () =>
			options.envFileVariables ?? new Map<string, string>(),
		processEnv: options.processEnv ?? {},
	};
}

describe("env-setup validation", () => {
	test("a drafted, OTel-wired, non-colliding target passes and starts", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const started: string[] = [];
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				startTarget: async (target) => {
					started.push(target.id);
					return { ready: true };
				},
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
		);
		expect(report.findings).toEqual([]);
		expect(report.ok).toBe(true);
		expect(started).toHaveLength(1);
		expect(report.targets[0]?.drafted).toBe(true);
		expect(report.targets[0]?.started).toBe("ready");
		expect(report.otel).toEqual([
			{ target: report.targets[0]?.id ?? "", ok: true },
		]);
	});

	test("a host port another app already declares fails the gate", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				otherAppPorts: new Map([[8090, "blog (blog-compose.yml)"]]),
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
		);
		expect(report.ok).toBe(false);
		const collision = report.findings.find(
			(finding) => finding.check === "port-collision",
		);
		expect(collision?.message).toContain("host port 8090");
		expect(collision?.message).toContain("blog (blog-compose.yml)");
	});

	test("a referenced variable the environment lacks is reported", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}      SHOP_TOKEN: \${SHOP_TOKEN}\n`,
		);
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.variables.missing).toEqual(["SHOP_TOKEN"]);
		expect(
			report.findings.some((finding) => finding.check === "missing-variable"),
		).toBe(true);
	});

	test("a drafted target without AC_OTEL_* wiring fails", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			"services:\n  shop:\n    image: shop:latest\n",
		);
		const report = await validateSetupDrafts(
			context({ configDir, draftsDir, checkoutDir: checkout }),
		);
		expect(report.ok).toBe(false);
		expect(report.findings.some((finding) => finding.check === "otel")).toBe(
			true,
		);
	});

	test("a target that does not reach readiness fails the gate", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				startTarget: async () => ({ ready: false, detail: "exit status 1" }),
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
		);
		expect(report.ok).toBe(false);
		const finding = report.findings.find((item) => item.check === "start");
		expect(finding?.message).toContain("exit status 1");
		expect(report.targets[0]?.started).toBe("failed");
	});

	test("a draft no run target resolves from is a finding", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "other-compose.yml"),
			"services:\n  other:\n    image: other\n",
		);
		const report = await validateSetupDrafts(
			context({ configDir, draftsDir, checkoutDir: checkout }),
		);
		expect(
			report.findings.some((finding) => finding.check === "undiscovered"),
		).toBe(true);
	});

	test("a malformed JSON draft is refused before anything starts", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "infrastructure", "definitions", "postgres.json"),
			'{"ident": "postgres",}\n',
		);
		const report = await validateSetupDrafts(
			context({ configDir, draftsDir, checkoutDir: checkout }),
		);
		expect(report.ok).toBe(false);
		expect(
			report.findings.some((finding) => finding.check === "unparsable"),
		).toBe(true);
	});
});

describe("port and variable parsing", () => {
	test("compose published ports are read from short and long syntax", () => {
		expect(
			composeHostPorts(
				[
					"services:",
					"  shop:",
					"    ports:",
					'      - "8080:80"',
					"      - 127.0.0.1:9090:90",
					"      - target: 90",
					'        published: "9091"',
					"      - 7000-7005:7000-7005/udp",
					"",
				].join("\n"),
			),
		).toEqual([8080, 9090, 9091, 7000]);
	});

	test("variables and OTel references are read from the draft text", () => {
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the variable reference is the subject
			referencesOtelVariables("x: ${AC_OTEL_ENDPOINT}"),
		).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the variable reference is the subject
		expect(referencesOtelVariables("x: ${OTHER}")).toBe(false);
		expect(
			setupVariables(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the references are the subject
				new Map([["a.yml", "x: ${A}\ny: ${B}\n"]]),
				new Map([["B", "1"]]),
				{},
			),
		).toEqual({ used: ["A", "B"], missing: ["A"] });
	});

	test("collisions are reported per drafted file", () => {
		expect(
			detectPortCollisions(
				"/drafts",
				new Map([["apps/compose/shop-compose.yml", COMPOSE_WITH_OTEL]]),
				new Map([[8090, "blog"]]),
			),
		).toEqual([
			"apps/compose/shop-compose.yml: host port 8090 is already declared by blog",
		]);
	});
});

// The check ids and ownership rules the assigned findings named
// (`add-environment-setup-workflow` verification round).
describe("env-setup validation boundaries", () => {
	test("a drafted target that does not compile is a finding", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const report = await validateSetupDrafts({
			...context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
			compileTarget: async (target) => {
				if (target.runtime === "docker") throw new Error("no such chart");
			},
		});
		expect(report.ok).toBe(false);
		const finding = report.findings.find((item) => item.check === "compile");
		expect(finding?.message).toContain("no such chart");
		expect(finding?.subject).toBe(report.targets[0]?.id);
	});

	test("an empty drafts directory and an empty draft file are findings", async () => {
		const configDir = tempDir("env-setup-validate-");
		const emptyDrafts = setupDraftsDir(configDir, "wf-empty");
		const checkout = tempDir("env-setup-validate-checkout-");
		const empty = await validateSetupDrafts(
			context({ configDir, draftsDir: emptyDrafts, checkoutDir: checkout }),
		);
		expect(empty.ok).toBe(false);
		expect(empty.drafts).toEqual([]);
		expect(empty.findings.some((item) => item.check === "no-drafts")).toBe(
			true,
		);

		const draftsDir = setupDraftsDir(configDir, "wf-1");
		writeFile(
			path.join(draftsDir, "infrastructure", "definitions", "postgres.json"),
			"   \n",
		);
		const blank = await validateSetupDrafts(
			context({ configDir, draftsDir, checkoutDir: checkout }),
		);
		expect(blank.findings.some((item) => item.check === "empty-file")).toBe(
			true,
		);
	});

	test("a draft outside the configuration layout is refused", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(path.join(draftsDir, ".env"), "SHOP_TOKEN=secret\n");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
		);
		expect(report.ok).toBe(false);
		const finding = report.findings.find(
			(item) => item.check === "unexpected-path",
		);
		expect(finding?.subject).toBe(".env");
	});

	test("a malformed definition is reported instead of thrown", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			[
				"services:",
				"  shop:",
				"    image: shop:latest",
				"x-devenv:",
				"  requires:",
				"    - app: other",
				"",
			].join("\n"),
		);
		const report = await validateSetupDrafts(
			context({ configDir, draftsDir, checkoutDir: checkout }),
		);
		expect(report.ok).toBe(false);
		expect(report.findings.some((item) => item.check === "discover")).toBe(
			true,
		);
	});

	test("an unreachable Kubernetes cluster skips the start instead of failing it", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "kubernetes", "shop-prod.k8s.json"),
			JSON.stringify({
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the drafted definition carries the injected variable
				wait: { otel: "${AC_OTEL_ENDPOINT}" },
				chart: { path: "$APP/deploy/helm" },
			}),
		);
		const started: string[] = [];
		const report = await validateSetupDrafts({
			...context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				startTarget: async (target) => {
					started.push(target.id);
					return { ready: true };
				},
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
			clusterAvailable: () => false,
		});
		expect(started).toEqual([]);
		expect(report.targets).toHaveLength(1);
		expect(report.targets[0]?.started).toBe("skipped");
		expect(report.targets[0]?.detail).toContain("not reachable");
		expect(report.findings.some((item) => item.check === "start")).toBe(false);
		expect(report.ok).toBe(true);
	});

	test("a drafted build definition is discovered and its absence reported", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.sh"),
			"echo build\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "build", "other-build.sh"),
			"echo other\n",
		);
		const report = await validateSetupDrafts(
			context({ configDir, draftsDir, checkoutDir: checkout }),
		);
		const undiscovered = report.findings.filter(
			(item) => item.check === "undiscovered",
		);
		expect(undiscovered.map((item) => item.subject)).toEqual([
			"apps/build/other-build.sh",
		]);
	});

	test("port ownership follows the configured app idents, not a hyphen split", () => {
		const configDir = tempDir("env-setup-ports-");
		writeFile(
			path.join(configDir, "apps", "definitions", "document-service.json"),
			'{"ident":"document-service"}\n',
		);
		writeFile(
			path.join(configDir, "apps", "definitions", "bhvr.json"),
			'{"ident":"bhvr"}\n',
		);
		writeFile(
			path.join(configDir, "apps", "definitions", "bhvr-site.json"),
			'{"ident":"bhvr-site"}\n',
		);
		writeFile(
			path.join(
				configDir,
				"apps",
				"compose",
				"document-service-Mocked-compose.yml",
			),
			'services:\n  document-service:\n    ports:\n      - "8095:8080"\n',
		);
		writeFile(
			path.join(configDir, "apps", "compose", "bhvr-site-compose.yml"),
			'services:\n  bhvr-site:\n    ports:\n      - "9001:80"\n',
		);
		writeFile(
			path.join(
				configDir,
				"apps",
				"kubernetes",
				"document-service-prod.k8s.json",
			),
			JSON.stringify({ ports: [{ localPort: 19095, remotePort: 8095 }] }),
		);
		// The app's own live definitions are never reported as another app's.
		expect(declaredAppPorts(configDir, "document-service").has(8095)).toBe(
			false,
		);
		expect(declaredAppPorts(configDir, "document-service").has(19095)).toBe(
			false,
		);
		// An ident that is a prefix of a longer one does not hide the other app.
		const ports = declaredAppPorts(configDir, "document-service");
		expect(ports.get(9001)).toBe("bhvr-site (bhvr-site-compose.yml)");
	});
});

// Round-2 findings: the drafts tree must be a plain, in-layout set of files,
// and the collision check must not hide a longer ident (`add-environment-setup-workflow`).
describe("env-setup validation provenance", () => {
	test("a symbolic link in the drafts tree is refused", async () => {
		const configDir = tempDir("env-setup-validate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-validate-checkout-");
		const outside = path.join(
			tempDir("env-setup-validate-outside-"),
			"payload.sh",
		);
		writeFile(outside, "echo payload\n");
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const linkPath = path.join(draftsDir, "apps", "run", "shop-linked.sh");
		fs.mkdirSync(path.dirname(linkPath), { recursive: true });
		fs.symlinkSync(outside, linkPath);
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				envFileVariables: new Map([
					["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"],
				]),
			}),
		);
		expect(report.ok).toBe(false);
		const finding = report.findings.find(
			(item) => item.check === "non-regular-file",
		);
		expect(finding?.subject).toBe("apps/run/shop-linked.sh");
	});

	test("a drafts directory outside the configuration root is a finding", async () => {
		const configDir = tempDir("env-setup-validate-");
		const elsewhere = tempDir("env-setup-validate-elsewhere-");
		writeFile(
			path.join(elsewhere, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const report = await validateSetupDrafts(
			context({
				configDir,
				draftsDir: elsewhere,
				checkoutDir: tempDir("env-setup-validate-checkout-"),
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.drafts).toEqual([]);
		const finding = report.findings.find(
			(item) => item.check === "unexpected-path",
		);
		expect(finding?.message).toContain("outside");
	});

	test("an ident that is a prefix of a longer one does not hide its ports", () => {
		const configDir = tempDir("env-setup-ports-");
		writeFile(
			path.join(configDir, "apps", "definitions", "installer.json"),
			'{"ident":"installer"}\n',
		);
		writeFile(
			path.join(configDir, "apps", "definitions", "installer-fe.json"),
			'{"ident":"installer-fe"}\n',
		);
		writeFile(
			path.join(configDir, "apps", "compose", "installer-compose.yml"),
			'services:\n  installer:\n    ports:\n      - "7001:80"\n',
		);
		writeFile(
			path.join(configDir, "apps", "compose", "installer-fe-compose.yml"),
			'services:\n  installer-fe:\n    ports:\n      - "7002:80"\n',
		);
		const ports = declaredAppPorts(configDir, "installer");
		// The app's own file is excluded; the longer ident's file is not.
		expect(ports.has(7001)).toBe(false);
		expect(ports.get(7002)).toBe("installer-fe (installer-fe-compose.yml)");
	});
});
