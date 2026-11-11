/** A curated, developer-visible refusal. The gateway masks every other error;
 * only this type's bounded single-line text reaches the TUI's error dialog.
 * Construct it only from fixed text or a value passed through `visible()`. */
export class Refusal extends Error {
	constructor(message: string) {
		super(visible(message));
		this.name = "Refusal";
	}
}
/** One line, credentials in URLs redacted, bounded. */
export function visible(message: string) {
	return (
		message
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "Operation refused"
	)
		.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1<redacted>@")
		.replace(/(authorization|token|password)[=:]\s*\S+/gi, "$1=<redacted>")
		.slice(0, 300);
}
