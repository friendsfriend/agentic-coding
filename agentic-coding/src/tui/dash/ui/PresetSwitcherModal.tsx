/** @jsxImportSource @opentui/solid */

import type { KeyEvent } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { SelectableList } from "./Selectable";

export interface PresetChoice {
	label: string;
	/** Undefined selects the effective configuration defaults. */
	value?: string;
}

/** Small workflow-scoped picker. Configuration management remains in
 * ModelConfigModal; this dialog only chooses a preset for the current run. */
export function PresetSwitcherModal(props: {
	choices: readonly PresetChoice[];
	selected?: string;
	onSelect: (preset: string | undefined) => void;
	onCancel: () => void;
	onKeyReady: (handler: (key: KeyEvent) => boolean) => void;
}) {
	const items = () => [...props.choices];
	const [selectedIndex, setSelectedIndex] = createSignal(
		Math.max(
			0,
			items().findIndex((item) => item.value === props.selected),
		),
	);
	const handler = (key: KeyEvent): boolean => {
		const name = key.name.toLowerCase();
		if (name === "escape") props.onCancel();
		else if (name === "j" || name === "down")
			setSelectedIndex((index) => Math.min(items().length - 1, index + 1));
		else if (name === "k" || name === "up")
			setSelectedIndex((index) => Math.max(0, index - 1));
		else if (name === "enter" || name === "return") {
			const preset = items()[selectedIndex()];
			if (preset) props.onSelect(preset.value);
		}
		return true;
	};
	onMount(() => props.onKeyReady(handler));
	onCleanup(() => props.onKeyReady(() => true));

	return (
		<GenericModal
			title="Switch agent preset"
			fieldLabel={`Current: ${props.selected ?? "Config defaults"}`}
			helpSections={false}
			help={[
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Switch and retrigger" },
				{ key: "Esc", action: "Cancel" },
			]}
		>
			{items().length ? (
				<SelectableList
					items={items()}
					selectedIndex={selectedIndex()}
					renderItem={(item, active) => (
						<text fg={active ? uiColors.primary : uiColors.textSecondary}>
							{item.value === props.selected
								? `✓ ${item.label}`
								: `  ${item.label}`}
						</text>
					)}
				/>
			) : (
				<text fg={uiColors.textMuted}>No agent presets configured.</text>
			)}
		</GenericModal>
	);
}
