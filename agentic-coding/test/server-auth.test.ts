// Owner-scoped agent environment capability (`add-agent-environment-tools`,
// task 1.1). The capability is the boundary the whole agent environment surface
// rests on: it must verify against the owner it was minted for, and it must not
// be forgeable from a name, a length, or the instance token itself.
import { describe, expect, test } from "bun:test";
import {
	authorizeEnvironmentRequest,
	createInstanceAuthority,
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
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
		for (const owner of ["user", "workflow:", "orchestrator"]) {
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
