export type TaskFailure = {
	message: string;
	detail: {
		kind:
			| "budget_exceeded"
			| "model_unavailable"
			| "rate_limited"
			| "provider_error";
		provider: string;
		model: string;
		profile: string;
		reason: string;
	};
};

/** Provider messages can echo keys, auth headers and credential URLs. Keep the
 * diagnostic, not credential-like values, in parent-visible durable outcomes. */
export function safeFailureMessage(message: string): string {
	return message
		.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1<redacted>@")
		.replace(/\bBearer\s+[^\s"']+/gi, "Bearer <redacted>")
		.replace(/\bsk-[^\s)"',;]+/g, "<redacted>")
		.replace(
			/\b(key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
			"$1$2<redacted>",
		)
		.slice(0, 8192);
}

export function taskFailure(
	failure: { reason?: string; detail?: unknown },
	profile: { id: string; provider: string; modelId: string },
): TaskFailure {
	const raw =
		typeof failure.detail === "string"
			? failure.detail
			: failure.detail === undefined
				? ""
				: JSON.stringify(failure.detail);
	const message = safeFailureMessage(
		raw || `Agent did not produce an answer (${failure.reason ?? "unknown"})`,
	);
	const kind =
		/budget[_ ](?:has been exceeded|exceeded)|budget.*exceeded/i.test(message)
			? "budget_exceeded"
			: failure.reason === "no_model" ||
					/model_not_available|model_not_found|requested model is not available|model.*(?:unavailable|not available)/i.test(
						message,
					)
				? "model_unavailable"
				: /\b429\b|rate[_ -]?limit/i.test(message)
					? "rate_limited"
					: "provider_error";
	return {
		message,
		detail: {
			kind,
			provider: profile.provider,
			model: profile.modelId,
			profile: profile.id,
			reason: safeFailureMessage(failure.reason ?? "unknown"),
		},
	};
}
