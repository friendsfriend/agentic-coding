/** @jsxImportSource @opentui/solid */

import {
	GenericModal,
	SelectableList,
	uiColors,
	useModalBackdrop,
} from "@agentic-coding/ui";
import type { KeyEvent } from "@opentui/core";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";

export interface PresetChoice {
	label: string;
	/** Undefined selects the effective configuration defaults. */
	value?: string;
}

/** Small workflow-scoped picker. Configuration management lives in the
 * Settings Agent Presets surface; this dialog only chooses a preset for the
 * current run. */
export function PresetSwitcherModal(props: {
	choices: readonly PresetChoice[];
	selected?: string;
	onSelect: (preset: string | undefined) => void;
	onCancel: () => void;
	onKeyReady: (handler: (key: KeyEvent) => boolean) => void;
}) {
	const items = createMemo(() => [...props.choices]);
	const [selectedIndex, setSelectedIndex] = createSignal(
		Math.max(
			0,
			items().findIndex((item) => item.value === props.selected),
		),
	);
	// Catalog refreshes may reorder or replace choice objects. Preserve the
	// developer's cursor by preset value, without tracking keyboard navigation.
	createEffect(
		on(items, (next, previous) => {
			if (!previous) return;
			const index = untrack(selectedIndex);
			const before = previous[index];
			const retained = before
				? next.findIndex((choice) => choice.value === before.value)
				: -1;
			setSelectedIndex(
				Math.max(
					0,
					retained >= 0 ? retained : Math.min(index, next.length - 1),
				),
			);
		}),
	);
	const renderChoice = (
		item: Accessor<PresetChoice>,
		active: Accessor<boolean>,
	) => (
		<text fg={active() ? uiColors.primary : uiColors.textSecondary}>
			{item().value === props.selected
				? `✓ ${item().label}`
				: `  ${item().label}`}
		</text>
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
	// Pointer parity: the same two steps the key takes — select, then an explicit
	// activation on the selected row switches the preset. The backdrop tap is the
	// `Esc` cancel, which is a non-destructive dismissal here.
	const backdrop = useModalBackdrop({
		kind: "settings-picker",
		dismiss: () => props.onCancel(),
	});
	const activateRow = (index: number) => {
		setSelectedIndex(index);
		const preset = items()[index];
		if (preset) props.onSelect(preset.value);
	};
	onMount(() => props.onKeyReady(handler));
	onCleanup(() => props.onKeyReady(() => true));

	return (
		<GenericModal
			{...backdrop}
			title="Switch agent preset"
			fieldLabel={`Current: ${props.selected ?? "Config defaults"}`}
			helpSections={false}
			help={[
				{ key: "j/k", action: "Navigate" },
				{ key: "Enter", action: "Switch and retrigger" },
				{ key: "Esc", action: "Cancel" },
			]}
		>
			<Show
				when={items().length > 0}
				fallback={
					<text fg={uiColors.textMuted}>No agent presets configured.</text>
				}
			>
				<SelectableList
					items={items()}
					itemKey={(item) => JSON.stringify([item.value])}
					selectedIndex={selectedIndex()}
					onSelect={setSelectedIndex}
					onActivate={activateRow}
					renderItem={(item, active) =>
						renderChoice(
							() => item,
							() => active,
						)
					}
					renderReactiveItem={renderChoice}
				/>
			</Show>
		</GenericModal>
	);
}
