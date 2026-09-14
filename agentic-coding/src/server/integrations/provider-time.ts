// Timestamp rendering shared by the provider ports
// (`port-git-providers-and-ai-to-bun`).
//
// Every Go provider type stored timestamps as `time.Time`, whose JSON encoding
// is RFC 3339 with a trimmed fractional part: `2026-01-02T03:04:05.000Z` comes
// back as `2026-01-02T03:04:05Z` and `.120Z` as `.12Z`. GitLab sends
// milliseconds, so the port has to trim them to stay byte-compatible with the
// recorded fixtures and with any other Go-written consumer.
export function goRfc3339(value: string): string {
	if (value === "") return value;
	const match = /\.(\d+)(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match) return value;
	const fraction = match[1].replace(/0+$/, "");
	return value.replace(
		/\.\d+(Z|[+-]\d{2}:\d{2})$/,
		fraction === "" ? "$1" : `.${fraction}$1`,
	);
}
