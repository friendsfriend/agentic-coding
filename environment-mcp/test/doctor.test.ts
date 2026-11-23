import { expect, test } from "bun:test";
import { createDoctorReport } from "../src/configuration/doctor.ts";
import { serverManifestSchema } from "../src/configuration/server-manifest.ts";

test("configuration doctor reports executable counts and sanitized migration issues", () => {
	const manifest = serverManifestSchema.parse({
		version: 1,
		repositories: ["/tmp/example-repository"],
		apps: [
			{
				id: "web",
				repository: "/tmp/example-repository",
				targets: [
					{
						id: "dev",
						action: "run",
						runtime: "shell",
						executable: {
							kind: "process",
							program: "/bin/sh",
							args: ["-lc", "sleep 30"],
							envRefs: { TOKEN: "MISSING" },
						},
					},
					{
						id: "mocked",
						action: "run",
						runtime: "compose",
						executionIssue: "container-name-prefix",
					},
				],
			},
		],
	});
	expect(createDoctorReport(manifest)).toMatchObject({
		version: 1,
		apps: 1,
		targets: 2,
		available: 1,
		unavailable: 1,
		byKind: { process: 1 },
		issues: [
			{
				app: "web",
				target: "mocked",
				issue: "container-name-prefix",
				hint: expect.stringContaining("environment-mcp-"),
			},
		],
	});
	expect(
		createDoctorReport(manifest, {
			secrets: {
				get: (reference) => (reference === "PRESENT" ? "x" : undefined),
			},
		}),
	).toMatchObject({
		secretGaps: [
			{
				app: "web",
				target: "dev",
				references: ["MISSING"],
			},
		],
	});
});
