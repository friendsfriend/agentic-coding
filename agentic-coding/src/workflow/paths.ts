// Static path constants. Module-level so tests/tools can override via env.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');
// src/workflow/paths.ts -> workflow -> src -> agentic-coding -> repo root
const here = fileURLToPath(import.meta.url);
export const AGENT_DEF_DIR = path.resolve(path.dirname(here), '..', '..', '..', 'agent-definitions');
export const CONFIG = process.env.HERDR_WORKFLOW_CONFIG || path.join(AGENT_DIR, 'herdr-workflow.toml');
export const SKILLS = path.join(AGENT_DEF_DIR, 'skills');
