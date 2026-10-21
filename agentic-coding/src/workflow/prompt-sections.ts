// The managed workflow protocol is one pinned asset made of an always-included
// core and optional sections (slim-agent-prompts). Each optional section is
// introduced by a marker line `<!-- protocol-section: <id> -->` directly before
// its `##` heading; a step declares which ids its role receives
// (`StepBehavior.protocolSections`), and the renderer drops the markers.
// Pure: no I/O, so the same parse serves the renderer, the inventory and tests.

export const PROTOCOL_SECTION_IDS = [
	"environment",
	"browser",
	"debug-tools",
	"delegated-debug",
	"file-signals",
	"jev",
] as const;
export type ProtocolSectionId = (typeof PROTOCOL_SECTION_IDS)[number];

export interface ProtocolSection {
	readonly id: ProtocolSectionId;
	readonly text: string;
}

export interface ParsedProtocol {
	readonly core: string;
	readonly sections: readonly ProtocolSection[];
}

const MARKER = /^<!-- protocol-section: ([a-z-]+) -->$/;

const isSectionId = (value: string): value is ProtocolSectionId =>
	(PROTOCOL_SECTION_IDS as readonly string[]).includes(value);

/** Splits the protocol file into its core and marked sections. An unknown or
 * repeated marker id is an error: the id set is closed. */
export function parseProtocol(text: string): ParsedProtocol {
	const core: string[] = [];
	const sections: { id: ProtocolSectionId; lines: string[] }[] = [];
	for (const line of text.split("\n")) {
		const marker = MARKER.exec(line.trim());
		if (marker) {
			const id = marker[1] ?? "";
			if (!isSectionId(id))
				throw new Error(`unknown protocol section id: ${id}`);
			if (sections.some((section) => section.id === id))
				throw new Error(`duplicate protocol section id: ${id}`);
			sections.push({ id, lines: [] });
			continue;
		}
		(sections.at(-1)?.lines ?? core).push(line);
	}
	return {
		core: core.join("\n").trim(),
		sections: sections.map((section) => ({
			id: section.id,
			text: section.lines.join("\n").trim(),
		})),
	};
}

/** The protocol as one role receives it: the core plus the selected sections in
 * file order, markers removed. `undefined` selects every section, so a step
 * that declares nothing loses nothing. */
export function selectProtocol(
	text: string,
	selected: readonly ProtocolSectionId[] | undefined,
): string {
	const parsed = parseProtocol(text);
	return [
		parsed.core,
		...parsed.sections
			.filter((section) => !selected || selected.includes(section.id))
			.map((section) => section.text),
	].join("\n\n");
}
