// Unified Bun backend transport tests (expose-unified-bun-backend, task 1.5 /
// 4.2). These exercise authorization, bounds, route ownership, event replay,
// credential ownership and retired delegation against a real loopback server
// with injected operations, so no filesystem/Git/Herdr work happens.

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { WorkflowView } from "../src/contracts/workflow.ts";
import {
	authorizeRequest,
	createInstanceAuthority,
	originAllowed,
} from "../src/server/auth.ts";
import { BackendClient } from "../src/server/client.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { runObservation } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import {
	EVENT_REPLAY_CAPACITY,
	ROUTE_OWNERSHIP,
	routeOwner,
} from "../src/server/protocol.ts";
import { run } from "../src/workflow/cli.ts";

/** A minimal but contract-shaped view: the client decodes every response, so a
 * fixture missing a required field is a real (and now detected) server bug. */
const stubView = {
	workflowId: "wf-1",
	changeId: "",
	revision: 3,
	definition: { id: "core", version: 1, digest: "d", label: "Core" },
	status: "active",
	repository: "/repo",
	worktree: "/repo",
	branch: "main",
	baseCommit: "abc",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	currentStep: {
		id: "core.plan",
		label: "Plan",
		attempt: 1,
		enteredAt: "2026-01-01T00:00:00.000Z",
	},
	runs: [],
	routing: {},
	effects: [],
	observations: [],
	health: { valid: true, attention: [] },
	availableActions: [],
} as unknown as WorkflowView;

function stubOperations(
	overrides: Partial<ServerOperations> = {},
): ServerOperations {
	const base: ServerOperations = {
		runObservation: async (request) => ({ echoed: request.kind }),
		listViews: () => [stubView],
		view: () => stubView,
		action: (request) => ({ ...stubView, revision: request.revision + 1 }),
		start: async (request) => `started ${request.workflowId}`,
		repair: () => stubView,
		question: () => stubView,
		saveReview: async () => {},
		execute: () => {},
		handoff: async () => stubView,
		saveAgents: () => {},
		loadAgents: () => ({
			agents: { profiles: {} },
			provenance: { source: "default", files: [] },
			conflicts: [],
			revision: "stub-revision",
		}),
		agentQuestion: async () => "answer",
		researchHandoff: async () => stubView,
	};
	return { ...base, ...overrides };
}

async function withServer<T>(
	run: (server: Awaited<ReturnType<typeof startWorkflowServer>>) => Promise<T>,
	operations: ServerOperations = stubOperations(),
): Promise<T> {
	const server = await startWorkflowServer({ operations });
	try {
		return await run(server);
	} finally {
		await server.stop();
	}
}

function authed(
	server: { token: string },
	init: RequestInit = {},
): RequestInit {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${server.token}`);
	return { ...init, headers };
}

describe("server route ownership", () => {
	test("static manifest resolves the versioned surface and its private operations", () => {
		expect(routeOwner("GET", "/api/v1/health")?.owner).toBe("bun");
		expect(routeOwner("POST", "/api/v1/observe")?.owner).toBe("bun");
		expect(routeOwner("GET", "/api/v1/events")?.owner).toBe("bun");
		expect(routeOwner("POST", "/api/v1/environment/private/state")?.owner).toBe(
			"bun",
		);
		// The delegated environment prefix and the retired Git bridge are gone:
		// neither path is served by this process or any other.
		expect(
			routeOwner("POST", "/api/v1/environment/api/apps/create"),
		).toBeUndefined();
		expect(
			routeOwner("POST", "/api/v1/integrations/private/git-command"),
		).toBeUndefined();
		expect(routeOwner("GET", "/api/v1/unknown")).toBeUndefined();
	});

	test("every manifest path is versioned and unique per method", () => {
		const seen = new Set<string>();
		for (const route of ROUTE_OWNERSHIP) {
			expect(route.path.startsWith("/api/v1/")).toBe(true);
			const key = `${route.method} ${route.path}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});
});

describe("instance authorization", () => {
	test("rejects a missing or forged capability", () => {
		const authority = createInstanceAuthority("inst-1");
		const request = new Request("http://127.0.0.1/api/v1/health");
		expect(() => authorizeRequest(request, authority)).toThrow(
			"missing instance capability",
		);
		const forged = new Request("http://127.0.0.1/api/v1/health", {
			headers: { authorization: "Bearer nope" },
		});
		expect(() => authorizeRequest(forged, authority)).toThrow(
			"invalid instance capability",
		);
	});

	test("accepts only loopback browser origins", () => {
		expect(originAllowed(null)).toBe(true);
		expect(originAllowed("http://127.0.0.1:4051")).toBe(true);
		expect(originAllowed("http://localhost:5173")).toBe(true);
		expect(originAllowed("https://evil.example")).toBe(false);
		expect(originAllowed("not a url")).toBe(false);
	});

	test("a foreign origin is rejected before routing", async () => {
		await withServer(async (server) => {
			const response = await fetch(`${server.url}/api/v1/health`, {
				headers: {
					authorization: `Bearer ${server.token}`,
					origin: "https://evil.example",
				},
			});
			expect(response.status).toBe(403);
		});
	});

	test("health requires the capability and reports the identity", async () => {
		await withServer(async (server) => {
			const denied = await fetch(`${server.url}/api/v1/health`);
			expect(denied.status).toBe(401);
			const ok = await fetch(`${server.url}/api/v1/health`, authed(server));
			expect(ok.status).toBe(200);
			const body = (await ok.json()) as { instance: string };
			expect(body.instance).toBe(server.instance);
		});
	});
});

describe("bounded payloads", () => {
	test("oversized declared bodies are rejected without dispatch", async () => {
		let called = false;
		await withServer(
			async (server) => {
				const response = await fetch(`${server.url}/api/v1/observe`, {
					method: "POST",
					...authed(server, {
						headers: { "content-length": String(64 * 1024 * 1024) },
					}),
					body: "{}",
				});
				expect(response.status).toBe(400);
				expect(called).toBe(false);
			},
			stubOperations({
				runObservation: async () => {
					called = true;
					return null;
				},
			}),
		);
	});

	test("unbounded paths are rejected", async () => {
		await withServer(async (server) => {
			const response = await fetch(
				`${server.url}/api/v1/${"a".repeat(5000)}`,
				authed(server),
			);
			expect(response.status).toBe(414);
		});
	});
});

describe("observation and workflow endpoints", () => {
	test("an artifact path that escapes the change root is rejected", async () => {
		await expect(
			runObservation({
				kind: "artifact-content",
				state: { changeId: "x", worktree: "/tmp/agentic-coding-escape" },
				artifact: "../secret.md",
			}),
		).rejects.toThrow("artifact path must be relative");
	});

	test("observe dispatches a decoded observation and returns its value", async () => {
		await withServer(async (server) => {
			const response = await fetch(`${server.url}/api/v1/observe`, {
				method: "POST",
				...authed(server, { headers: { "content-type": "application/json" } }),
				body: JSON.stringify({ observation: { kind: "projects" } }),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				ok: boolean;
				value: { echoed: string };
			};
			expect(body.ok).toBe(true);
			expect(body.value.echoed).toBe("projects");
		});
	});

	test("an unknown observation kind is a bounded decode error", async () => {
		await withServer(async (server) => {
			const response = await fetch(`${server.url}/api/v1/observe`, {
				method: "POST",
				...authed(server, { headers: { "content-type": "application/json" } }),
				body: JSON.stringify({ observation: { kind: "nonsense" } }),
			});
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: { message: string } };
			expect(body.error.message).not.toContain("nonsense");
		});
	});

	test("a rejected decode never echoes a supplied secret", async () => {
		await withServer(async (server) => {
			const response = await fetch(`${server.url}/api/v1/observe`, {
				method: "POST",
				...authed(server, {
					headers: { "content-type": "application/json" },
				}),
				body: JSON.stringify({
					observation: { kind: "projects", capability: "super-secret-value" },
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain("super-secret-value");
		});
	});

	test("a workflow action commits and publishes an event", async () => {
		await withServer(async (server) => {
			const before = server.app.events.currentSequence;
			const response = await fetch(`${server.url}/api/v1/workflow/action`, {
				method: "POST",
				...authed(server, { headers: { "content-type": "application/json" } }),
				body: JSON.stringify({
					repo: "/repo",
					workflowId: "wf-1",
					revision: 3,
					actionId: "approve",
				}),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { value: { revision: number } };
			expect(body.value.revision).toBe(4);
			expect(server.app.events.currentSequence).toBe(before + 1);
			expect(server.app.events.replay(before).events[0]).toMatchObject({
				resource: "/repo",
				runId: "wf-1",
			});
		});
	});

	test("a stale revision field is rejected by the operation, not mutated", async () => {
		await withServer(
			async (server) => {
				const response = await fetch(`${server.url}/api/v1/workflow/action`, {
					method: "POST",
					...authed(server, {
						headers: { "content-type": "application/json" },
					}),
					body: JSON.stringify({
						repo: "/repo",
						workflowId: "wf-1",
						revision: 1,
						actionId: "approve",
					}),
				});
				expect(response.status).toBe(400);
				const body = (await response.json()) as {
					error: { message: string };
				};
				expect(body.error.message).toContain("stale revision");
			},
			stubOperations({
				action: (request) => {
					if (request.revision !== 3) throw new Error("stale revision");
					return stubView;
				},
			}),
		);
	});
});

describe("event broker", () => {
	test("publishes monotonic envelopes and replays inside the window", () => {
		const broker = new EventBroker("inst-1", 4);
		broker.publish({ domain: "workflow", kind: "a" });
		broker.publish({ domain: "workflow", kind: "b" });
		broker.publish({ domain: "workflow", kind: "c" });
		expect(broker.currentSequence).toBe(3);
		expect(broker.replay(1).events.map((event) => event.kind)).toEqual([
			"b",
			"c",
		]);
		expect(broker.replay(1).snapshotRequired).toBe(false);
	});

	test("a cursor outside the retained window requires a snapshot", () => {
		const broker = new EventBroker("inst-1", 2);
		for (let index = 0; index < 5; index++)
			broker.publish({ domain: "workflow", kind: `e${index}` });
		expect(broker.replay(1).snapshotRequired).toBe(true);
		expect(broker.replay(99).snapshotRequired).toBe(true);
		expect(broker.replay(4).events.map((event) => event.kind)).toEqual(["e4"]);
	});

	test("a slow subscriber overflows to a snapshot request instead of blocking", () => {
		const broker = new EventBroker("inst-1", 2);
		const subscription = broker.open({});
		for (let index = 0; index < 10; index++)
			broker.publish({ domain: "telemetry", kind: `e${index}` });
		expect(subscription.snapshotRequired).toBe(false);
		subscription.unsubscribe();
		expect(broker.subscriberCount).toBe(0);
	});

	test("replay capacity is the documented constant", () => {
		const broker = new EventBroker("inst-1");
		expect(broker.capacity).toBe(EVENT_REPLAY_CAPACITY);
	});
});

describe("credential interactions", () => {
	test("only the owning client can answer", async () => {
		const registry = new CredentialRegistry(1000);
		const pending = registry.request("owner-a");
		const id = registry.newestFor("owner-a");
		expect(id).toBeDefined();
		expect(registry.respond("owner-b", id ?? "", "stolen").accepted).toBe(
			false,
		);
		expect(registry.respond("owner-a", id ?? "", "secret").accepted).toBe(true);
		expect(await pending).toBe("secret");
	});

	test("an unknown interaction is rejected without using the value", () => {
		const registry = new CredentialRegistry(1000);
		expect(registry.respond("owner-a", "cred-999", "secret").accepted).toBe(
			false,
		);
	});

	test("a disconnect cancels the owned interaction within its bound", async () => {
		const registry = new CredentialRegistry(60_000);
		const pending = registry.request("owner-a");
		expect(registry.ownerDisconnected("owner-a")).toBe(1);
		expect(await pending).toBe("");
	});

	test("an unanswered interaction expires to an empty answer", async () => {
		const registry = new CredentialRegistry(5);
		expect(await registry.request("owner-a")).toBe("");
	});
});

describe("retired delegation", () => {
	test("the delegated environment prefix is gone, not forwarded", async () => {
		await withServer(async (server) => {
			const response = await fetch(
				`${server.url}/api/v1/environment/api/apps`,
				authed(server),
			);
			// The mixed-runtime prefix used to be forwarded to the Go child. With
			// that runtime retired the route does not exist, and the private
			// environment operation is the only environment path that does.
			expect(response.status).toBe(404);
		});
	});
});

describe("acceptance: recovery and shutdown", () => {
	test("backend work continues while a client stops reading", async () => {
		await withServer(async (server) => {
			// A suspended renderer: the SSE stream is open but never read.
			const controller = new AbortController();
			const stream = await fetch(`${server.url}/api/v1/events`, {
				...authed(server),
				signal: controller.signal,
			});
			expect(stream.ok).toBe(true);
			const before = server.app.events.currentSequence;
			// Backend mutations and event publication are not blocked by the
			// non-reading client.
			const action = await fetch(`${server.url}/api/v1/workflow/action`, {
				method: "POST",
				...authed(server, { headers: { "content-type": "application/json" } }),
				body: JSON.stringify({
					repo: "/repo",
					workflowId: "wf-1",
					revision: 3,
					actionId: "approve",
				}),
			});
			expect(action.status).toBe(200);
			expect(server.app.events.currentSequence).toBeGreaterThan(before);
			// A second active client still gets a response.
			const health = await fetch(`${server.url}/api/v1/health`, authed(server));
			expect(health.status).toBe(200);
			controller.abort();
		});
	});

	test("repeated reads stay observational and publish no events", async () => {
		let reads = 0;
		await withServer(
			async (server) => {
				const before = server.app.events.currentSequence;
				for (let index = 0; index < 3; index++) {
					const response = await fetch(`${server.url}/api/v1/observe`, {
						method: "POST",
						...authed(server, {
							headers: { "content-type": "application/json" },
						}),
						body: JSON.stringify({ observation: { kind: "projects" } }),
					});
					expect(response.status).toBe(200);
				}
				expect(reads).toBe(3);
				expect(server.app.events.currentSequence).toBe(before);
			},
			stubOperations({
				runObservation: async () => {
					reads += 1;
					return [];
				},
			}),
		);
	});

	test("a lost mutation response is reconciled by re-reading the view", async () => {
		let committed = 3;
		await withServer(
			async (server) => {
				// Simulate the response being dropped: the action commits, but the
				// client retries a read instead of replaying the mutation.
				await fetch(`${server.url}/api/v1/workflow/action`, {
					method: "POST",
					...authed(server, {
						headers: { "content-type": "application/json" },
					}),
					body: JSON.stringify({
						repo: "/repo",
						workflowId: "wf-1",
						revision: 3,
						actionId: "approve",
					}),
				});
				const reconciled = await fetch(
					`${server.url}/api/v1/workflow/view?repo=/repo&workflowId=wf-1`,
					authed(server),
				);
				const body = (await reconciled.json()) as {
					value: { revision: number };
				};
				expect(body.value.revision).toBe(committed);
			},
			stubOperations({
				action: () => {
					committed += 1;
					return {
						...stubView,
						revision: committed,
					} as unknown as WorkflowView;
				},
				view: () =>
					({ ...stubView, revision: committed }) as unknown as WorkflowView,
			}),
		);
	});

	test("shutdown cancels a pending credential interaction", async () => {
		const server = await startWorkflowServer({ operations: stubOperations() });
		const pending = server.app.credentials.request("owner-a");
		expect(server.app.credentials.pendingFor("owner-a")).toHaveLength(1);
		await server.stop();
		expect(await pending).toBe("");
		expect(server.app.credentials.pendingFor("owner-a")).toHaveLength(0);
	});

	test("a cursor from a previous instance requires a snapshot", async () => {
		await withServer(async (server) => {
			const controller = new AbortController();
			const response = await fetch(`${server.url}/api/v1/events?cursor=99`, {
				...authed(server),
				signal: controller.signal,
			});
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("no SSE body");
			let text = "";
			const decoder = new TextDecoder();
			for (
				let attempt = 0;
				attempt < 10 && !text.includes("resync");
				attempt++
			) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			controller.abort();
			expect(text).toContain("event: resync");
		});
	});
});

describe("workflow event hub", () => {
	test("executing a repository registers it with the hub", async () => {
		const repos: string[] = [];
		const server = await startWorkflowServer({
			operations: stubOperations(),
			hub: {
				watchRepo: (repo) => repos.push(repo),
				stop: () => {},
			},
		});
		try {
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "tui-1",
			});
			await client.execute({ repo: "/repo", workflowId: "wf-1" });
			expect(repos).toEqual(["/repo"]);
		} finally {
			await server.stop();
		}
	});
});

describe("agent config mutations", () => {
	test("forwards a data mutation through the typed client", async () => {
		let seen: unknown;
		await withServer(
			async (server) => {
				const client = new BackendClient({
					baseUrl: server.url,
					token: server.token,
					ownerId: "tui-1",
				});
				await client.saveAgents({
					repository: "/repo",
					mutation: { kind: "delete-preset", name: "legacy" },
				});
				expect(seen).toMatchObject({
					repository: "/repo",
					mutation: { kind: "delete-preset", name: "legacy" },
				});
			},
			stubOperations({
				saveAgents: (request) => {
					seen = request;
				},
			}),
		);
	});
});

describe("agent question", () => {
	test("forwards the environment and publishes question creation", async () => {
		let seen: unknown;
		await withServer(
			async (server) => {
				const events: unknown[] = [];
				const subscription = server.app.events.open({}, (event) =>
					events.push(event),
				);
				try {
					const client = new BackendClient({
						baseUrl: server.url,
						token: server.token,
						ownerId: "agent-1",
					});
					const answer = await client.agentQuestion({
						repo: "/repo",
						environment: { HERDR_RUN_ID: "run-1" },
						input: { description: "Which?" },
						timeoutMs: 1000,
					});
					expect(answer).toBe("answer");
					expect(seen).toMatchObject({
						repo: "/repo",
						environment: { HERDR_RUN_ID: "run-1" },
						input: { description: "Which?" },
						timeoutMs: 1000,
					});
					expect(events).toContainEqual(
						expect.objectContaining({
							domain: "workflow",
							kind: "workflow.question",
							resource: "/repo",
							runId: "wf-1",
							revision: 4,
						}),
					);
				} finally {
					subscription.unsubscribe();
				}
			},
			stubOperations({
				agentQuestion: async (request, _signal, onCreated) => {
					seen = request;
					onCreated?.("wf-1", 4);
					return "answer";
				},
			}),
		);
	});
});

describe("agent research handoff", () => {
	test("forwards the structured handoff payload", async () => {
		let seen: unknown;
		await withServer(
			async (server) => {
				const client = new BackendClient({
					baseUrl: server.url,
					token: server.token,
					ownerId: "agent-1",
				});
				const view = await client.researchHandoff({
					repo: "/repo",
					environment: { HERDR_RUN_ID: "run-1" },
					handoff: { subject: "Topic", directives: [], citations: [] },
				});
				expect(view.workflowId).toBe("wf-1");
				expect(seen).toMatchObject({
					repo: "/repo",
					handoff: { subject: "Topic" },
				});
			},
			stubOperations({
				researchHandoff: async (request) => {
					seen = request;
					return stubView;
				},
			}),
		);
	});
});

describe("agent handoff", () => {
	test("forwards the authenticated caller environment over the transport", async () => {
		let seen: unknown;
		await withServer(
			async (server) => {
				const client = new BackendClient({
					baseUrl: server.url,
					token: server.token,
					ownerId: "agent-1",
				});
				const view = await client.agentHandoff({
					repo: "/repo",
					environment: { HERDR_RUN_ID: "run-1" },
					outcome: "complete",
				});
				expect(view.workflowId).toBe("wf-1");
				expect(seen).toMatchObject({
					repo: "/repo",
					environment: { HERDR_RUN_ID: "run-1" },
					outcome: "complete",
				});
			},
			stubOperations({
				handoff: async (request) => {
					seen = request;
					return stubView;
				},
			}),
		);
	});
	test("rejects an untrusted origin before delegating", async () => {
		await withServer(async (server) => {
			const response = await fetch(`${server.url}/api/v1/agent/handoff`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${server.token}`,
					origin: "https://evil.example",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					repo: "/repo",
					environment: {},
					outcome: "complete",
				}),
			});
			expect(response.status).toBe(403);
		});
	});
});

describe("headless CLI reads through the exported boundary", () => {
	test("status uses the server when the shell exports URL and token", async () => {
		await withServer(async (server) => {
			const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
			const previousToken = process.env.AGENTIC_WORKFLOW_TOKEN;
			process.env.AGENTIC_WORKFLOW_URL = server.url;
			process.env.AGENTIC_WORKFLOW_TOKEN = server.token;
			const output: string[] = [];
			const originalLog = console.log;
			console.log = (value?: unknown) => {
				output.push(String(value));
			};
			try {
				await run(["status", "--repo", "/repo", "--workflow-id", "wf-1"]);
			} finally {
				console.log = originalLog;
				if (previousUrl === undefined) delete process.env.AGENTIC_WORKFLOW_URL;
				else process.env.AGENTIC_WORKFLOW_URL = previousUrl;
				if (previousToken === undefined)
					delete process.env.AGENTIC_WORKFLOW_TOKEN;
				else process.env.AGENTIC_WORKFLOW_TOKEN = previousToken;
			}
			expect(JSON.parse(output.join("\n")).workflowId).toBe("wf-1");
		});
	});
});

describe("typed client", () => {
	test("observes, acts and responds over the authenticated transport", async () => {
		await withServer(async (server) => {
			const client = new BackendClient({
				baseUrl: server.url,
				token: server.token,
				ownerId: "owner-a",
			});
			const observed = await client.observe<{ echoed: string }>(
				{ kind: "projects" },
				Schema.Struct({ echoed: Schema.String }),
			);
			expect(observed.echoed).toBe("projects");
			const view = await client.action({
				repo: "/repo",
				workflowId: "wf-1",
				revision: 3,
				actionId: "approve",
			});
			expect(view.revision).toBe(4);
		});
	});
});
