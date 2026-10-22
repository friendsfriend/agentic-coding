// Register OpenTUI's embedded-terminal renderable with the Solid JSX runtime.
//
// `@opentui/solid` ships a fixed intrinsic catalogue; a custom renderable must
// be added with `extend()` before the first JSX element of that name is
// created. Keeping the registration and the module augmentation together means
// a view only has to import this module, and TypeScript knows the element's
// options (cols/rows/onData/onTerminalResize).
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { extend } from "@opentui/solid";

extend({ embedded_terminal: EmbeddedTerminalRenderable });

declare module "@opentui/solid" {
	interface OpenTUIComponents {
		embedded_terminal: typeof EmbeddedTerminalRenderable;
	}
}
