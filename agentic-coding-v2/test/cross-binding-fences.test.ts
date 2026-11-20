import { expect, test } from "bun:test";
import { environmentSchema } from "./fixtures/environment-schema.ts";

// Rule tables exercise the schema directly. The authenticated draft scenario in
// container-subset-fences.test.ts covers stored-valid/stored-invalid inspection;
// no model, persistence or listener is needed for each declaration.
const compose = (override: Record<string, unknown>) => ({
	id: "run",
	action: "run",
	runtime: "compose",
	compose: {
		file: "compose.yml",
		provider: "docker",
		socket: "/var/run/docker.sock",
	},
	...override,
});
const refusedPlans: Array<
	[string, Record<string, unknown>, "app" | "infrastructure"]
> = [
	[
		"service selectors on a shell target",
		{
			id: "run",
			action: "run",
			runtime: "shell",
			command: "serve",
			readyText: "ready",
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web" },
		},
		"app",
	],
	[
		"query service on a shell target",
		{
			id: "run",
			action: "run",
			runtime: "shell",
			command: "serve",
			readyText: "ready",
			queryService: "db",
		},
		"app",
	],
	[
		"compose endpoint without a service selector",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: {},
		}),
		"app",
	],
	[
		"selector for an undeclared endpoint",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web", ghost: "worker" },
		}),
		"app",
	],
	[
		"invalid selector value",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "Web!" },
		}),
		"app",
	],
	[
		"query service without a query connection",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web" },
			queryService: "db",
		}),
		"app",
	],
	[
		"invalid query service selector",
		compose({
			endpoints: { api: "http://127.0.0.1:8080/v1" },
			endpointServices: { api: "web" },
			queryService: "Bad!",
			queryConnection: {
				protocol: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "db",
				usernameRef: "U",
				passwordRef: "P",
			},
			secretRefs: { U: "U", P: "P" },
		}),
		"infrastructure",
	],
	[
		"container endpoints without health readiness",
		{
			id: "run",
			action: "run",
			runtime: "docker",
			container: { socket: "/var/run/docker.sock", image: "fixture:latest" },
			endpoints: { api: "http://127.0.0.1:8080/v1" },
		},
		"app",
	],
	[
		"container endpoint on an unpublished port",
		{
			id: "run",
			action: "run",
			runtime: "docker",
			container: {
				socket: "/var/run/docker.sock",
				image: "fixture:latest",
				readiness: "healthy",
				ports: [{ host: 18080, container: 8080 }],
			},
			endpoints: { api: "http://127.0.0.1:9999/v1" },
		},
		"app",
	],
	[
		"pod endpoints without a forward on the endpoint port",
		{
			id: "run",
			action: "run",
			runtime: "kubernetes",
			kubernetes: {
				cluster: "fixture",
				namespace: "work",
				image: "fixture:latest",
				replicas: 1,
				readinessProbe: { tcpSocket: { port: 8080 } },
			},
			endpoints: { api: "http://127.0.0.1:8080/v1" },
		},
		"app",
	],
	[
		"pod query without a forward on the query port",
		{
			id: "run",
			action: "run",
			runtime: "kubernetes",
			kubernetes: {
				cluster: "fixture",
				namespace: "work",
				image: "fixture:latest",
				replicas: 1,
				readinessProbe: { tcpSocket: { port: 5432 } },
				portForwards: [{ local: 18080, remote: 8080 }],
			},
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
];
test.each(refusedPlans)("schema refuses %s", (_label, target, kind) => {
	expect(() => environmentSchema([target], kind)).toThrow();
});
test("schema inspection admits a consistent compose declaration with query service", () => {
	expect(
		environmentSchema(
			[
				compose({
					endpoints: { api: "http://127.0.0.1:8080/v1" },
					endpointServices: { api: "web" },
					queryService: "db",
					queryConnection: {
						protocol: "postgres",
						host: "127.0.0.1",
						port: 5432,
						database: "db",
						usernameRef: "U",
						passwordRef: "P",
					},
					secretRefs: { U: "U", P: "P" },
				}),
			],
			"infrastructure",
		),
	).toHaveLength(1);
});
test("schema inspection admits a healthy container declaration with a published endpoint", () => {
	expect(
		environmentSchema(
			[
				{
					id: "run",
					action: "run",
					runtime: "docker",
					container: {
						socket: "/var/run/docker.sock",
						image: "fixture:latest",
						readiness: "healthy",
						ports: [{ host: 18080, container: 8080 }],
					},
					endpoints: { api: "http://127.0.0.1:18080/v1" },
				},
			],
			"app",
		),
	).toHaveLength(1);
});
test("schema inspection admits a pod declaration with a forward on every used port", () => {
	expect(
		environmentSchema(
			[
				{
					id: "run",
					action: "run",
					runtime: "kubernetes",
					kubernetes: {
						cluster: "fixture",
						namespace: "work",
						image: "fixture:latest",
						replicas: 1,
						readinessProbe: { tcpSocket: { port: 8080 } },
						portForwards: [
							{ local: 18080, remote: 8080 },
							{ local: 15432, remote: 5432 },
						],
					},
					endpoints: { api: "http://127.0.0.1:18080/v1" },
					queryConnection: {
						protocol: "postgres",
						host: "127.0.0.1",
						port: 15432,
						database: "db",
						usernameRef: "U",
						passwordRef: "P",
					},
					secretRefs: { U: "U", P: "P" },
				},
			],
			"infrastructure",
		),
	).toHaveLength(1);
});
