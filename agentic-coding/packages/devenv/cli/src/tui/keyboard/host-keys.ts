// The host shell owns a small set of keys on every surface; an embedded
// feature must not claim them. The registry lives with the shell
// (`src/tui/shared/hostKeys.ts`) so the shell's own layer, its footer/help
// catalogs and the feature layers all read one declaration.
export {
	HOST_KEY_BINDINGS,
	HOST_KEYBINDS,
	hostKeybind,
	hostOwnedKeys,
} from "../../../../../../src/tui/shared/hostKeys";
