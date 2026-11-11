/** @jsxImportSource @opentui/solid */
// v1's theme modal interaction, over the copied shared picker. Only the local
// v2 preferences adapter owns persistence; no gateway or execution permission.
import type { KeyEvent } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createSignal, onCleanup } from "solid-js";
import {
	getActiveThemeName,
	ThemePickerModal,
	themeNames,
} from "../../ui/index.ts";
import { applyTheme, saveThemeName } from "../environments/preferences.ts";

export function SettingsThemePicker(props: {
	active: () => boolean;
	close: () => void;
	error: (message: string) => void;
}) {
	const original = getActiveThemeName();
	const [index, setIndex] = createSignal(
		Math.max(0, themeNames.indexOf(original)),
	);
	const [query, setQuery] = createSignal("");
	const [filtering, setFiltering] = createSignal(false);
	const items = () =>
		themeNames.filter((name) => name.includes(query().toLowerCase()));
	let saved = false;
	const select = (next: number) => {
		const name = items()[next];
		if (!name) return;
		setIndex(next);
		applyTheme(name);
	};
	const handle = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		if (key === "escape") {
			props.close();
		} else if (key === "enter" || key === "return") {
			const name = items()[index()];
			if (name) {
				try {
					saveThemeName(name);
					applyTheme(name);
					saved = true;
					props.close();
				} catch {
					props.error(
						"Theme could not be saved; the previous preference was not replaced.",
					);
				}
			}
		} else if (key === "/") {
			setFiltering(true);
			setQuery("");
			setIndex(0);
		} else if (filtering() && key === "backspace") {
			setQuery((value) => value.slice(0, -1));
			setIndex(0);
		} else if (
			filtering() &&
			event.sequence?.length === 1 &&
			event.sequence >= " "
		) {
			setQuery((value) => value + event.sequence);
			setIndex(0);
		} else if (key === "j" || key === "down") {
			select(Math.min(items().length - 1, index() + 1));
		} else if (key === "k" || key === "up") {
			select(Math.max(0, index() - 1));
		}
		return true;
	};
	const keys = [
		"escape",
		"return",
		"enter",
		"backspace",
		"delete",
		"tab",
		"shift+tab",
		"up",
		"down",
		"left",
		"right",
		"home",
		"end",
		"pageup",
		"pagedown",
		..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_[]{};:\\|,.<>`~!@#$%^&*() /'\"="
			.split("")
			.map((key) => (key === " " ? "space" : key)),
	];
	const unregister = useKeymap().registerLayer({
		id: "v2.settings.theme-picker",
		priority: 150,
		enabled: props.active,
		commands: [
			{ name: "settings.theme.handle", run: ({ event }) => handle(event) },
		],
		bindings: [...new Set(keys)].map((key) => ({
			key,
			cmd: "settings.theme.handle",
		})),
	});
	onCleanup(() => {
		unregister();
		if (!saved) applyTheme(original);
	});
	return (
		<ThemePickerModal
			selected={index}
			active={getActiveThemeName}
			themes={items}
			query={query}
			filtering={filtering}
			onSelect={select}
		/>
	);
}
