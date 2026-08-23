// Loose module declaration so tests that exercise pi extensions type-check
// without the pi-coding-agent package installed in this project.
declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		// biome-ignore lint/suspicious/noExplicitAny: loose declaration for an external package
		[key: string]: any;
	}
}
