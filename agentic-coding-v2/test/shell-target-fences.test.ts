import { expect, test } from "bun:test";
import { environmentSchema } from "./fixtures/environment-schema.ts";

// Rule tables exercise the schema directly. The authenticated draft scenario in
// container-subset-fences.test.ts covers stored-valid/stored-invalid inspection;
// no model, persistence or listener is needed for each declaration.
const refusedTargets: Array<
	[string, Record<string, unknown>, ("app" | "library" | "infrastructure")?]
> = [
	[
		"shell mixed with container configuration",
		{ command: "serve", container: { socket: "/s", image: "i" } },
	],
	[
		"shell run query without readiness text",
		{
			command: "serve",
			queryConnection: {
				protocol: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
			secretRefs: { U: "U", P: "P" },
		},
		"infrastructure",
	],
	["empty command", { command: "   ", readyText: "ready" }],
	[
		"oversized command",
		{ command: `run ${"x".repeat(16000)}`, readyText: "ready" },
	],
	[
		"oversized readiness text",
		{ command: "serve", readyText: `r${"e".repeat(512)}` },
	],
	["absolute cwd", { command: "serve", readyText: "ready", cwd: "/tmp" }],
	[
		"telemetry on a container run",
		{
			runtime: "docker",
			container: { socket: "/s", image: "i" },
			command: undefined,
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
		},
	],
	[
		"telemetry without readiness text",
		{
			command: "serve",
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
		},
	],
	[
		"telemetry with a literal exporter variable",
		{
			command: "serve",
			readyText: "ready",
			telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
			environment: { OTEL_METRICS_EXPORTER: "x" },
		},
	],
	[
		"compose with container overrides",
		{
			runtime: "compose",
			command: undefined,
			container: { socket: "/s", image: "i" },
			compose: { file: "c.yml", provider: "docker", socket: "/s" },
		},
	],
	[
		"run target in a library",
		{ command: "serve", readyText: "ready", action: "run" },
		"library",
	],
	[
		"non-run target in infrastructure",
		{ command: "serve", readyText: "ready", action: "test" },
		"infrastructure",
	],
	["duplicate target IDs", { command: "serve", readyText: "ready" }],
];
test.each(refusedTargets)(
	"schema refuses %s",
	(label, override, kind = "app") => {
		const target = { id: "run", action: "run", runtime: "shell", ...override };
		const targets =
			label === "duplicate target IDs" ? [target, { ...target }] : [target];
		expect(() => environmentSchema(targets, kind)).toThrow();
	},
);
test("schema inspection admits a ready shell run with loopback telemetry", () => {
	expect(
		environmentSchema(
			[
				{
					id: "run",
					action: "run",
					runtime: "shell",
					command: "serve --port 8080",
					readyText: "listening",
					cwd: "work",
					telemetry: {
						protocol: "otlp-http-json",
						listen: "127.0.0.1:0",
					},
				},
			],
			"app",
		),
	).toHaveLength(1);
});
