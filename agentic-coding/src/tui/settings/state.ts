// Settings runtime state (centralize-application-settings).
//
// The shell owns navigation and key dispatch; this module owns the little state
// that outlives a single key event: the resolved provider/project snapshots read
// from the connected server and whether the shared profile/preset editor is
// open. Reads never fall back to a local configuration file, so an unavailable
// server stays a retryable section error.

import { type KeybindSection, PAGE_NAVIGATION_KEYBINDS } from "@ui";
import { createSignal } from "solid-js";
import type { ProjectSnapshot, ProviderSnapshot } from "./items";
import { readProjectStatus, readProviderStatus } from "./server-config";

const [providerSnapshot, setProviderSnapshot] = createSignal<ProviderSnapshot>({
	state: "loading",
	providers: [],
});
const [projectSnapshot, setProjectSnapshot] = createSignal<ProjectSnapshot>({
	state: "loading",
	projects: [],
});

export function settingsProviders(): ProviderSnapshot {
	return providerSnapshot();
}

export function settingsProjects(): ProjectSnapshot {
	return projectSnapshot();
}

let providerRead = 0;
let projectRead = 0;

/** Read provider status from the connected server. A failure is a section
 * error with a retry, never a local fallback. */
export async function refreshSettingsProviders(
	baseUrl: string | undefined,
): Promise<void> {
	const generation = ++providerRead;
	if (!baseUrl) {
		setProviderSnapshot({
			state: "error",
			providers: [],
			error: "no connected server",
		});
		return;
	}
	setProviderSnapshot((current) => ({ ...current, state: "loading" }));
	try {
		const providers = await readProviderStatus(baseUrl);
		if (generation !== providerRead) return;
		setProviderSnapshot({ state: "ready", providers });
	} catch (error) {
		if (generation !== providerRead) return;
		setProviderSnapshot({
			state: "error",
			providers: [],
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Read the configured project catalog. A failure is a section error. */
export async function refreshSettingsProjects(
	baseUrl: string | undefined,
): Promise<void> {
	const generation = ++projectRead;
	setProjectSnapshot((current) => ({ ...current, state: "loading" }));
	try {
		const snapshot = await readProjectStatus(baseUrl ? { baseUrl } : {});
		if (generation !== projectRead) return;
		setProjectSnapshot({
			state: "ready",
			revision: snapshot.revision,
			projects: snapshot.projects.map((project) => ({
				ident: project.ident,
				displayName: project.displayName,
				kind: project.kind,
				available: project.available,
				...(project.canonicalRoot
					? { repository: project.canonicalRoot }
					: project.activeCheckout
						? { repository: project.activeCheckout }
						: {}),
			})),
		});
	} catch (error) {
		if (generation !== projectRead) return;
		setProjectSnapshot({
			state: "error",
			projects: [],
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Footer/`?` help catalog for the Settings surface. */
export function settingsKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Navigation",
			keybinds: [
				{ key: "j/k or ↑/↓", action: "select setting", standard: true },
				{ key: "Enter", action: "activate setting", standard: true },
				...PAGE_NAVIGATION_KEYBINDS,
			],
		},
		{
			title: "Actions",
			keybinds: [
				{ key: "Ctrl+P", action: "locations", short: "locations" },
				{ key: "R", action: "reload server settings", short: "reload" },
				{ key: "T", action: "theme picker", short: "theme" },
				{ key: "?", action: "help" },
				{ key: "q", action: "quit", standard: true },
			],
		},
	];
}
