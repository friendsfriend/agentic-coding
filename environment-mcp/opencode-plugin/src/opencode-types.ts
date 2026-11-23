import type { ColorInput } from "@opentui/core";
import type { JSX } from "solid-js";

/**
 * Minimal structural copy of the OpenCode 2.0.22 TUI plugin contract.
 *
 * The host validates the exported object shape at runtime and aliases the
 * plugin runtime imports itself. Keeping the contract structural avoids a
 * runtime dependency on the private `@opencode/plugin` package (whose
 * dependency graph is not installable outside the OpenCode workspace) while
 * still type-checking the surface this plugin actually uses.
 *
 * Source: anomalyco/opencode v2.0.22, packages/plugin/src/tui/context.ts and
 * packages/plugin/src/tui/plugin.ts.
 */

export type Theme = {
	readonly text: {
		readonly base: ColorInput;
		readonly muted: ColorInput;
		readonly action: {
			readonly primary: {
				readonly base: ColorInput;
				readonly focused: ColorInput;
			};
		};
		readonly feedback: {
			readonly success: {
				readonly base: ColorInput;
				readonly muted: ColorInput;
			};
			readonly error: { readonly base: ColorInput; readonly muted: ColorInput };
			readonly warning: {
				readonly base: ColorInput;
				readonly muted: ColorInput;
			};
			readonly info: { readonly base: ColorInput; readonly muted: ColorInput };
		};
	};
	readonly background: {
		readonly base: ColorInput;
		readonly raised: {
			readonly base: ColorInput;
			readonly high: ColorInput;
			readonly max: ColorInput;
		};
		readonly action: {
			readonly primary: { readonly focused: ColorInput };
		};
	};
	readonly border: { readonly base: ColorInput };
};

export type Route =
	| { readonly type: "home" }
	| { readonly type: "session"; readonly sessionID: string }
	| {
			readonly type: "plugin";
			readonly id: string;
			readonly name: string;
			readonly data?: Record<string, unknown>;
	  };

export type Destination =
	| Route
	| {
			readonly type: "plugin";
			readonly name: string;
			readonly data?: Record<string, unknown>;
	  };

export type Page = {
	readonly name: string;
	readonly render: (input: {
		readonly data?: Record<string, unknown>;
	}) => JSX.Element;
};

export type KeymapCommand = {
	readonly id?: string;
	readonly title?: string;
	readonly description?: string;
	readonly group?: string;
	readonly enabled?: boolean | (() => boolean);
	readonly bind?: false | string;
	readonly palette?: true;
	readonly slash?: {
		readonly name: string;
		readonly aliases?: string[];
		readonly arguments?: true;
	};
	readonly suggested?: boolean | (() => boolean);
	readonly run: (
		input?: string,
		event?: unknown,
	) => void | false | Promise<void>;
};

export type KeymapLayer = {
	readonly mode?: string;
	readonly enabled?: boolean | (() => boolean);
	readonly priority?: number;
	readonly commands?: readonly KeymapCommand[];
};

export type ToastOptions = {
	readonly title?: string;
	readonly message: string;
	readonly variant?: "info" | "success" | "warning" | "error";
	readonly duration?: number;
};

export type Dialog = {
	show(render: () => JSX.Element, onClose?: () => void): void;
	set(options: {
		readonly size?: "medium" | "large" | "xlarge";
		readonly centered?: boolean;
	}): void;
	clear(): void;
};

export type SlotClaim = {
	readonly append: string;
	readonly render: () => JSX.Element;
};

export type Context = {
	readonly options: Readonly<Record<string, unknown>>;
	readonly app: { readonly version: string; readonly channel: string };
	readonly theme: Theme;
	readonly keymap: {
		layer(input: () => KeymapLayer): void;
		dispatch(id: string, input?: string): void;
	};
	readonly ui: {
		readonly dialog: Dialog;
		readonly toast: { show(options: ToastOptions): void };
		readonly router: {
			register(page: Page): () => void;
			navigate(destination: Destination): void;
			current(): Route;
		};
		slot(claim: SlotClaim): () => void;
	};
};

export type PluginDefinition = {
	readonly id: string;
	readonly setup: (context: Context) => void | Promise<void>;
};
