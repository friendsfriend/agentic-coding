// Owner-scoped agent environment capability (`add-agent-environment-tools`,
// task 1.1). The capability is the boundary the whole agent environment surface
// rests on: it must verify against the owner it was minted for, and it must not
// be forgeable from a name, a length, or the instance token itself.
import { describe, expect, test } from "bun:test";
import {
	authorizeEnvironmentRequest,
	authorizeOrchestratorConversation,
	authorizeRequest,
	createInstanceAuthority,
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
	orchestratorConversationTokenFor,
	orchestratorTokenFor,
} from "../src/server/auth.ts";

const authority = createInstanceAuthority("inst-1", "instance-token-value");

function environmentRequest(
	owner: string | undefined,
	token: string | undefined,
): Request {
	const headers = new Headers();
	if (owner !== undefined) headers.set(ENVIRONMENT_OWNER_HEADER, owner);
	if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
	return new Request("http://127.0.0.1:4050/api/v1/agent-env/list", {
		headers,
	});
}

describe("agent environment capability", () => {
	test("accepts the capability minted for the owner it names", () => {
		const owner = "workflow:wf-alpha";
		expect(
			authorizeEnvironmentRequest(
				environmentRequest(owner, environmentTokenFor(authority.token, owner)),
				authority,
			),
		).toBe(owner);
	});

	test("refuses another owner's capability", () => {
		// The shape of the request is valid and the token is a real capability —
		// it was just minted for a different owner, which is exactly what the
		// owner-bound HMAC has to catch.
		const request = environmentRequest(
			"workflow:wf-beta",
			environmentTokenFor(authority.token, "workflow:wf-alpha"),
		);
		expect(() => authorizeEnvironmentRequest(request, authority)).toThrow(
			"invalid agent environment capability",
		);
	});

	test("refuses a tampered token and an instance or orchestrator capability", () => {
		const owner = "workflow:wf-alpha";
		const minted = environmentTokenFor(authority.token, owner);
		const tampered = `${minted.slice(0, -1)}${minted.endsWith("a") ? "b" : "a"}`;
		expect(tampered).not.toBe(minted);
		expect(() =>
			authorizeEnvironmentRequest(
				environmentRequest(owner, tampered),
				authority,
			),
		).toThrow("invalid agent environment capability");
		// The instance token and the orchestrator capability are wider than this
		// surface: neither may open an agent environment route.
		for (const wider of [
			authority.token,
			orchestratorTokenFor(authority.token),
		]) {
			expect(() =>
				authorizeEnvironmentRequest(
					environmentRequest(owner, wider),
					authority,
				),
			).toThrow("invalid agent environment capability");
		}
	});

	test("compares in constant time, so a shorter token is refused without a length oracle", () => {
		const owner = "workflow:wf-alpha";
		const minted = environmentTokenFor(authority.token, owner);
		// A prefix, a longer value and a same-length wrong value all answer the
		// same way: none of them reaches a comparison that could leak where the
		// first difference is.
		for (const candidate of [
			minted.slice(0, -1),
			`${minted}0`,
			"0".repeat(minted.length),
		]) {
			expect(() =>
				authorizeEnvironmentRequest(
					environmentRequest(owner, candidate),
					authority,
				),
			).toThrow("invalid agent environment capability");
		}
	});

	test("requires an owner header and a bearer capability", () => {
		expect(() =>
			authorizeEnvironmentRequest(
				environmentRequest(undefined, "x"),
				authority,
			),
		).toThrow("missing or invalid agent environment owner");
		// A name that is not a workflow owner is not a capability to verify.
		for (const owner of ["workflow:", "orchestrator"]) {
			expect(() =>
				authorizeEnvironmentRequest(
					environmentRequest(
						owner,
						environmentTokenFor(authority.token, owner),
					),
					authority,
				),
			).toThrow("missing or invalid agent environment owner");
		}
		expect(() =>
			authorizeEnvironmentRequest(
				environmentRequest("workflow:a", undefined),
				authority,
			),
		).toThrow("missing agent environment capability");
	});

	test("binds the capability to the owner and hides the instance token", () => {
		const alpha = environmentTokenFor(authority.token, "workflow:a");
		const beta = environmentTokenFor(authority.token, "workflow:b");
		expect(alpha).not.toBe(beta);
		expect(alpha).not.toBe(orchestratorTokenFor(authority.token));
		expect(alpha).not.toContain(authority.token);
		// A different instance mints a different capability for the same owner.
		expect(
			environmentTokenFor(
				createInstanceAuthority("inst-2", "other-token").token,
				"workflow:a",
			),
		).not.toBe(alpha);
	});
});

describe("orchestrator conversation capability", () => {
	const identity = { hostId: "host", conversationId: "conversation" };
	const token = orchestratorConversationTokenFor(authority.token, identity);
	const request = (capability: string) =>
		environmentRequest("user", capability);

	test("names only the authenticated conversation and keeps orchestrator policy", () => {
		expect(
			authorizeOrchestratorConversation(request(token), authority),
		).toEqual(identity);
		expect(authorizeRequest(request(token), authority)).toBe("orchestrator");
		expect(authorizeEnvironmentRequest(request(token), authority)).toBe("user");
		expect(() =>
			authorizeEnvironmentRequest(
				environmentRequest("workflow:alpha", token),
				authority,
			),
		).toThrow();
	});

	test("instance and shared orchestrator tokens cannot claim a calling conversation", () => {
		for (const capability of [
			authority.token,
			orchestratorTokenFor(authority.token),
			environmentTokenFor(authority.token, "workflow:alpha"),
		])
			expect(() =>
				authorizeOrchestratorConversation(request(capability), authority),
			).toThrow();
	});

	test("refuses forgery, payload mutation, another instance and noncanonical envelopes", () => {
		const payload = Buffer.from(
			JSON.stringify(["host", "another-conversation"]),
		).toString("base64url");
		const signature = token.split(".")[2];
		for (const capability of [
			`oc1.${payload}.${signature}`,
			orchestratorConversationTokenFor(
				orchestratorTokenFor(authority.token),
				identity,
			),
			orchestratorConversationTokenFor("another-instance", identity),
			`${token}.extra`,
			token.slice(0, -1),
			`oc1.${Buffer.from("{}").toString("base64url")}.forged`,
			`oc1.${"x".repeat(2048)}.forged`,
		])
			expect(() =>
				authorizeOrchestratorConversation(request(capability), authority),
			).toThrow();
	});

	test("caller JSON and headers cannot override authenticated identity", () => {
		const forged = new Request("http://127.0.0.1/api/v1/workflow/action", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"x-orchestrator-conversation": "another",
			},
			body: JSON.stringify({ hostId: "another", conversationId: "another" }),
		});
		expect(authorizeOrchestratorConversation(forged, authority)).toEqual(
			identity,
		);
		const other = orchestratorConversationTokenFor(authority.token, {
			...identity,
			conversationId: "new",
		});
		expect(other).not.toBe(token);
		expect(
			authorizeOrchestratorConversation(request(other), authority)
				.conversationId,
		).toBe("new");
	});

	test("bounds identities and rejects untrusted origins", () => {
		for (const hostId of [
			"",
			" ",
			"x".repeat(257),
			"😀".repeat(65),
			"host\nother",
		])
			expect(() =>
				orchestratorConversationTokenFor(authority.token, {
					...identity,
					hostId,
				}),
			).toThrow();
		expect(() =>
			authorizeOrchestratorConversation(
				new Request("http://127.0.0.1/", {
					headers: {
						authorization: `Bearer ${token}`,
						origin: "https://untrusted.example",
					},
				}),
				authority,
			),
		).toThrow("untrusted origin");
	});
});

test("orchestrator environment capability is confined to user ownership", () => {
	const token = orchestratorTokenFor(authority.token);
	expect(
		authorizeEnvironmentRequest(environmentRequest("user", token), authority),
	).toBe("user");
	for (const denied of [
		authority.token,
		environmentTokenFor(authority.token, "user"),
		environmentTokenFor(authority.token, "workflow:alpha"),
		orchestratorTokenFor("other-instance"),
		"forged",
	]) {
		expect(() =>
			authorizeEnvironmentRequest(
				environmentRequest("user", denied),
				authority,
			),
		).toThrow("invalid agent environment capability");
	}
	const headers = new Headers({
		authorization: `Bearer ${token}`,
		[ENVIRONMENT_OWNER_HEADER]: "user",
		origin: "https://untrusted.example",
	});
	expect(() =>
		authorizeEnvironmentRequest(
			new Request("http://127.0.0.1/api/v1/agent-env/list", { headers }),
			authority,
		),
	).toThrow("untrusted origin");
});
