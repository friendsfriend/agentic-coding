export type StandaloneMode = "pi" | "opencode";
export type StandaloneSession = {
	id: string;
	mode: StandaloneMode;
	title: string;
	repository: string;
	profile: string;
	status: "ready" | "busy" | "uncertain" | "closed";
	revision: number;
	messages: { role: "user" | "assistant"; content: string }[];
	truncated: boolean;
	partial: string | null;
};
export type StandaloneMethods = {
	"standalone.read": { input: { id?: string }; output: StandaloneInventory };
	"standalone.create": {
		input: {
			mode: StandaloneMode;
			profile: string;
			repository: string;
			title: string;
		};
		output: StandaloneSession;
	};
	"standalone.send": {
		input: { id: string; revision: number; content: string; requestId: string };
		output: StandaloneSession;
	};
	"standalone.compact": {
		input: {
			id: string;
			revision: number;
			requestId: string;
			instructions?: string;
		};
		output: StandaloneSession;
	};
	"standalone.abort": { input: { id: string }; output: { aborted: true } };
	"standalone.configure": {
		input: { id: string; revision: number; profile: string };
		output: { configured: true };
	};
	"standalone.retire": {
		input: { id: string; revision: number };
		output: { retired: true };
	};
};
export type StandaloneInventory = {
	sessions: StandaloneSession[];
	piAvailable: boolean;
	opencodeAvailable: boolean;
	scope: string;
};
