// Host-owned boundary: discover and authenticate the instance server ourselves.
// A control client cannot supply a verifier URL, a permit, or an epoch.
import { decodeContract } from "../contracts/decode.ts";
import {
	LAUNCH_VERIFY_PATH,
	type LaunchClaim,
	type LaunchPermit,
	launchPermitSchema,
} from "../contracts/launch.ts";
import { ensureEnvironmentServer } from "./environment-capability.ts";

export class LaunchVerificationError extends Error {
	constructor(
		readonly kind: "unavailable" | "refused",
		message: string,
	) {
		super(message);
	}
}

export async function verifyWorkflowLaunch(
	claim: LaunchClaim,
): Promise<LaunchPermit> {
	const server = await ensureEnvironmentServer();
	if (!server)
		throw new LaunchVerificationError(
			"unavailable",
			"Launch verification unavailable; start a compatible background server, then inspect workflow status before dispatch.",
		);
	let response: Response;
	try {
		response = await fetch(new URL(LAUNCH_VERIFY_PATH, server.url), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${server.token}`,
			},
			body: JSON.stringify(claim),
			redirect: "error",
			signal: AbortSignal.timeout(5_000),
		});
	} catch {
		throw new LaunchVerificationError(
			"unavailable",
			"Launch verification unavailable; check the background server and inspect workflow status. Remote admission was not authorized.",
		);
	}
	if (!response.ok)
		throw new LaunchVerificationError(
			response.status === 409 ? "refused" : "unavailable",
			response.status === 409
				? "Launch claim refused by the server; inspect current workflow status before dispatch."
				: "Launch verification refused; check background server authentication and version before dispatch.",
		);
	let permit: LaunchPermit;
	try {
		const reader = response.body?.getReader();
		if (!reader) throw new Error("empty response");
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > 16_384) {
				await reader.cancel();
				throw new Error("response exceeds bound");
			}
			chunks.push(result.value);
		}
		permit = decodeContract(
			"server.workflow.launch-permit",
			launchPermitSchema,
			JSON.parse(Buffer.concat(chunks).toString("utf8")),
		);
	} catch {
		throw new LaunchVerificationError(
			"unavailable",
			"Launch verification response invalid or unavailable; inspect background server status before dispatch.",
		);
	}
	if (
		permit.workflowId !== claim.workflowId ||
		permit.runId !== claim.runId ||
		!Number.isSafeInteger(permit.revision) ||
		!Number.isSafeInteger(permit.claimAttempt) ||
		permit.claimAttempt < 1
	)
		throw new LaunchVerificationError(
			"unavailable",
			"Launch verifier returned an inconsistent identity.",
		);
	return permit;
}
