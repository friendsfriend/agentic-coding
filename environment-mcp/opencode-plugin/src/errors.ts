export function errorCopy(message: string | undefined) {
	const text = message ?? "";
	if (
		/client token|ECONNREFUSED|fetch failed|network error|network request|timed out|timeout|ENOTFOUND/i.test(
			text,
		)
	) {
		return {
			title: "Environment unavailable",
			hint: "Check that the environment-mcp service is running and the client token is readable. Press r to retry.",
		};
	}
	return {
		title: "Request failed",
		hint: "The capability refused this request. Check the app, repository and target state, then press r to retry.",
	};
}
