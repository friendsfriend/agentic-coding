/**
 * OpenCode server plugin: native worktree management plus a child-session
 * launcher.
 *
 * The built-in `subagent` tool cannot place a child session in a worktree:
 * child sessions inherit the parent's location. These tools bridge the gap with
 * the native worktree/session APIs:
 *
 *   create_worktree -> start_agent(directory) -> session.create(parentID)
 *     -> session.move -> session.prompt
 *
 * The child remains a child of the caller, so its completion notification still
 * reaches the orchestrator.
 *
 * No runtime imports: the host decodes the plain `{ id, setup }` plugin shape.
 */

type ToolResult = {
	output?: unknown;
	content?: string;
	metadata?: Record<string, unknown>;
};

type ToolContext = {
	sessionID: string;
	agent: string;
	signal: AbortSignal;
};

type ToolEditor = {
	add(tool: {
		name: string;
		description: string;
		input: Record<string, unknown>;
		output?: Record<string, unknown>;
		execute: (
			input: Record<string, unknown>,
			context: ToolContext,
		) => Promise<ToolResult>;
	}): void;
};

type Registration = { dispose(): Promise<void> };

type Context = {
	location: {
		directory: string;
		project: { id: string };
	};
	worktree: {
		create(input: {
			projectID: string;
			from?: string;
			branch?: string;
			directory?: string;
			name?: string;
		}): Promise<{ directory: string }>;
		remove(input: {
			projectID: string;
			directory: string;
			force: boolean;
		}): Promise<void>;
		list(input: {
			projectID: string;
		}): Promise<ReadonlyArray<{ directory: string; strategy?: string }>>;
	};
	session: {
		create(input: {
			parentID: string;
			title?: string;
			agent?: string;
			model?: { providerID: string; id: string; variant?: string };
		}): Promise<{ id: string }>;
		get(input: { sessionID: string }): Promise<{
			model?: { providerID: string; id: string; variant?: string };
		}>;
		move(input: { sessionID: string; directory: string }): Promise<void>;
		prompt(input: { sessionID: string; text: string }): Promise<unknown>;
		remove(input: { sessionID: string }): Promise<void>;
	};
	agent: {
		get(input: { agentID: string }): Promise<{
			data: {
				mode: string;
				model?: { providerID: string; id: string; variant?: string };
			};
		}>;
	};
	tool: {
		transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
	};
};

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function optionalText(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return text(value, name);
}

function worktreeInput(value: unknown):
	| {
			name?: string;
			branch?: string;
			from?: string;
			directory?: string;
	  }
	| undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error("worktree must be an object");
	const input = value as Record<string, unknown>;
	return {
		name: optionalText(input.name, "worktree.name"),
		branch: optionalText(input.branch, "worktree.branch"),
		from: optionalText(input.from, "worktree.from"),
		directory: optionalText(input.directory, "worktree.directory"),
	};
}

const worktreeCreateInput = {
	type: "object",
	properties: {
		name: {
			type: "string",
			description: "Lowercase kebab-case worktree name.",
		},
		branch: {
			type: "string",
			description: "Starting ref for the worktree, not the new branch name.",
		},
		from: {
			type: "string",
			description: "Source directory/ref to create from. Defaults to the project worktree.",
		},
		directory: {
			type: "string",
			description: "Parent directory for the worktree. Defaults to the project setting.",
		},
	},
	additionalProperties: false,
} as const;

const worktreeCreateOutput = {
	type: "object",
	properties: { directory: { type: "string" } },
	required: ["directory"],
	additionalProperties: false,
} as const;

const worktreeListOutput = {
	type: "object",
	properties: {
		worktrees: {
			type: "array",
			items: {
				type: "object",
				properties: {
					directory: { type: "string" },
					type: { type: "string", enum: ["root", "worktree"] },
				},
				required: ["directory", "type"],
				additionalProperties: false,
			},
		},
	},
	required: ["worktrees"],
	additionalProperties: false,
} as const;

const agentInput = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			description:
				"Subagent ID, for example openspec-apply, verify-workflow, or openspec-verifier.",
		},
		description: {
			type: "string",
			description: "Short 3-5 word label for the child session.",
		},
		prompt: {
			type: "string",
			description:
				"Full assignment. Child sessions start fresh; include change id, directory, scope, files, checks, and expected result.",
		},
		directory: {
			type: "string",
			description:
				"Existing worktree or directory for the child. Omit to share the caller's directory.",
		},
		worktree: {
			type: "object",
			description:
				"Create a new native worktree for this child. Do not combine with directory.",
			properties: {
				name: { type: "string" },
				branch: { type: "string" },
				from: { type: "string" },
				directory: { type: "string" },
			},
			additionalProperties: false,
		},
	},
	required: ["agent", "description", "prompt"],
	additionalProperties: false,
} as const;

const agentOutput = {
	type: "object",
	properties: {
		sessionID: { type: "string" },
		directory: { type: "string" },
		status: { type: "string" },
	},
	required: ["sessionID", "directory", "status"],
	additionalProperties: false,
} as const;

export default {
	id: "openspec.worktree",
	async setup(context: Context) {
		const registration = await context.tool.transform((editor) => {
			editor.add({
				name: "create_worktree",
				description:
					"Create a native OpenCode worktree for the current project. Returns its directory. Use one worktree per OpenSpec change and pass it to every child.",
				input: worktreeCreateInput,
				output: worktreeCreateOutput,
				async execute(raw) {
					const input = worktreeInput(raw);
					if (!input) throw new Error("worktree options are required");
					const created = await context.worktree.create({
						projectID: context.location.project.id,
						...(input.from ? { from: input.from } : {}),
						...(input.branch ? { branch: input.branch } : {}),
						...(input.directory ? { directory: input.directory } : {}),
						...(input.name ? { name: input.name } : {}),
					});
					return {
						output: { directory: created.directory },
						content: `Created worktree at ${created.directory}.`,
						metadata: { directory: created.directory },
					};
				},
			});

			editor.add({
				name: "list_worktrees",
				description:
					"List the current project's root checkout and saved worktrees.",
				input: { type: "object", additionalProperties: false },
				output: worktreeListOutput,
				async execute() {
					const worktrees = (
						await context.worktree.list({
							projectID: context.location.project.id,
						})
					).map((item) => ({
						directory: item.directory,
						type: item.strategy ? ("worktree" as const) : ("root" as const),
					}));
					return {
						output: { worktrees },
						content: worktrees.length
							? worktrees
									.map((item) => `${item.type}\t${item.directory}`)
									.join("\n")
							: "No worktrees recorded.",
						metadata: { count: worktrees.length },
					};
				},
			});

			editor.add({
				name: "remove_worktree",
				description:
					"Remove a saved worktree from the current project. Use force only for a disposable worktree with local changes.",
				input: {
					type: "object",
					properties: {
						directory: { type: "string" },
						force: { type: "boolean" },
					},
					required: ["directory"],
					additionalProperties: false,
				},
				output: {
					type: "object",
					properties: { removed: { type: "boolean" } },
					required: ["removed"],
					additionalProperties: false,
				},
				async execute(raw) {
					const directory = text(raw.directory, "directory");
					const force = raw.force === true;
					await context.worktree.remove({
						projectID: context.location.project.id,
						directory,
						force,
					});
					return {
						output: { removed: true },
						content: `Removed worktree ${directory}.`,
						metadata: { directory },
					};
				},
			});

			editor.add({
				name: "move_session",
				description:
					"Move the current session or a named session to an existing worktree/directory. Use this to move the orchestrator into the change worktree before writing proposal artifacts.",
				input: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						directory: { type: "string" },
					},
					required: ["directory"],
					additionalProperties: false,
				},
				output: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						directory: { type: "string" },
					},
					required: ["sessionID", "directory"],
					additionalProperties: false,
				},
				async execute(raw, tool) {
					const directory = text(raw.directory, "directory");
					const sessionID = optionalText(raw.sessionID, "sessionID") ?? tool.sessionID;
					await context.session.move({ sessionID, directory });
					return {
						output: { sessionID, directory },
						content: `Moved session ${sessionID} to ${directory}.`,
						metadata: { sessionID, directory },
					};
				},
			});

			editor.add({
				name: "start_agent",
				description: [
					"Start a child agent in the current directory or in a native OpenCode worktree.",
					"Use this instead of `subagent` when a child needs its own worktree.",
					"`worktree` creates a new worktree; `directory` reuses an existing one; omit both to share the caller's directory.",
					"For one OpenSpec change, create the worktree once with create_worktree and pass the same `directory` to apply, verify, fix, and archive.",
					"The tool returns immediately. The child runs in the background and its completion is delivered to this session; do not poll.",
				].join("\n"),
				input: agentInput,
				output: agentOutput,
				async execute(raw, tool) {
					const agent = text(raw.agent, "agent");
					const title = text(raw.description, "description");
					const prompt = text(raw.prompt, "prompt");
					const directory = optionalText(raw.directory, "directory");
					const requested = worktreeInput(raw.worktree);
					if (directory && requested)
						throw new Error("Use either directory or worktree, not both");

					const selected = await context.agent.get({ agentID: agent });
					if (selected.data.mode === "primary")
						throw new Error(`${agent} is a primary agent and cannot run as a child`);
					const parent = await context.session.get({ sessionID: tool.sessionID });
					const model = selected.data.model ?? parent.model;

					let target = directory ?? context.location.directory;
					let createdWorktree = false;
					if (requested) {
						const worktree = await context.worktree.create({
							projectID: context.location.project.id,
							...(requested.from ? { from: requested.from } : {}),
							...(requested.branch ? { branch: requested.branch } : {}),
							...(requested.directory ? { directory: requested.directory } : {}),
							...(requested.name ? { name: requested.name } : {}),
						});
						target = worktree.directory;
						createdWorktree = true;
					}

					let child: { id: string } | undefined;
					try {
						child = await context.session.create({
							parentID: tool.sessionID,
							title,
							agent,
							...(model ? { model } : {}),
						});
						if (target !== context.location.directory)
							await context.session.move({
								sessionID: child.id,
								directory: target,
							});
						await context.session.prompt({
							sessionID: child.id,
							text: prompt,
						});
					} catch (error) {
						if (child) await context.session.remove({ sessionID: child.id }).catch(() => undefined);
						throw error;
					}

					if (!child) throw new Error("child session was not created");
					const result = {
						sessionID: child.id,
						directory: target,
						status: "running",
					};
					return {
						output: result,
						content: [
							`Started ${agent} in ${target} (session ${child.id}).`,
							createdWorktree ? "Created a new worktree." : "Used an existing directory.",
							"The child is running in the background; its completion will arrive in this session.",
						].join("\n"),
						metadata: { ...result, agent, worktree: createdWorktree },
					};
				},
			});
		});
		return () => registration.dispose();
	},
};
