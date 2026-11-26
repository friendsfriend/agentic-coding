export type AppDefaults = {
	build?: string;
	test?: string;
	run?: string;
};

export type ConfigurationMutation =
	| {
			operation: "app-create";
			app: {
				id: string;
				kind?: "app" | "library" | "infrastructure";
				repository: string;
				defaults?: AppDefaults;
			};
	  }
	| {
			operation: "app-update";
			id: string;
			kind?: "app" | "library" | "infrastructure";
			repository?: string;
			defaults?: AppDefaults;
	  }
	| { operation: "app-delete"; id: string; deleteTargets: boolean }
	| {
			operation: "target-create";
			mode: "duplicate";
			app: string;
			sourceApp: string;
			sourceTarget: string;
			id: string;
			profile?: string;
	  }
	| {
			operation: "target-create";
			mode: "shell";
			app: string;
			id: string;
			action: "build" | "test" | "run";
			profile?: string;
			command: string;
			timeoutSec?: number;
			environment?: Record<string, string>;
			secretRefs?: Record<string, string>;
			readyText?: string;
	  }
	| {
			operation: "target-update";
			app: string;
			id: string;
			profile?: string | null;
			action?: "build" | "test" | "run";
			command?: string;
			timeoutSec?: number;
			readyText?: string | null;
			dependsOn?: readonly Record<string, unknown>[];
			prerequisites?: readonly { app: string; target: string }[];
			endpoints?: Record<string, string>;
			endpointServices?: Record<string, string>;
	  }
	| { operation: "target-delete"; app: string; id: string };

export type ConfigurationRevision = {
	digest: string;
	apps: number;
	targets: number;
	repositories: readonly string[];
};

export type ConfigurationPreview = {
	status: "confirmation-required";
	expectedDigest: string;
	nextDigest: string;
	confirm: string;
	summary: string;
};

export type ConfigurationApplyResult = {
	status: "completed";
	digest: string;
	summary: string;
};

export type ConfigurationMutationResult =
	| ConfigurationPreview
	| ConfigurationApplyResult;
