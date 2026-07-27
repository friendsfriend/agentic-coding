// Plugin subcommand orchestration — install/list Pi extensions. Kept separate from
// phase orchestration (orchestration.ts) per R2's module boundaries. Discovery/
// assignment I/O itself lives in prompts.ts (plugin discovery is a prompt-building
// concern shared with pi_arguments).
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.ts';
import * as prompts from './prompts.ts';

export interface PluginArgs {
  pluginCommand: 'list' | 'install' | 'install-local';
  source?: string;
  path?: string;
  worker?: boolean;
  planner?: boolean;
}

export function cmdPlugin(config: any, args: PluginArgs): void {
  if (args.pluginCommand === 'list') pluginList(config);
  else if (args.pluginCommand === 'install') pluginInstall(args);
  else if (args.pluginCommand === 'install-local') pluginInstallLocal(args);
}

function pluginList(config: any): void {
  const extensions = prompts.discoverExtensions();
  const assignments = prompts.loadPluginAssignments();
  const assignedRolesByStem: Record<string, string[]> = {};
  for (const plugin of assignments.plugins ?? []) {
    const roles = plugin.agentRoles ?? [];
    if (!roles.length) continue;
    const stem = path.basename(plugin.source, path.extname(plugin.source));
    if (!(stem in assignedRolesByStem)) assignedRolesByStem[stem] = roles;
  }

  if (!Object.keys(extensions).length) {
    console.log('No extensions found.');
    return;
  }

  console.log(`${'Extension'.padEnd(40)} ${'Active for'.padEnd(20)} ${'Status'.padEnd(30)}`);
  console.log('-'.repeat(90));
  for (const name of Object.keys(extensions).sort()) {
    const rolesStatus = [...prompts.UNRESTRICTED_ROLES]
      .sort()
      .map(role => `${role}=${prompts.resolveExclusions(config, role).has(name) ? 'excluded' : ''}`);
    const status = rolesStatus.join(', ');
    const assignmentRoles = assignedRolesByStem[name] ?? [];
    const roleTag = assignmentRoles.length ? assignmentRoles.join(',') : 'all';
    console.log(`${name.padEnd(40)} ${roleTag.padEnd(20)} ${status.padEnd(30)}`);
  }
}

function pluginInstall(args: PluginArgs): void {
  const source = args.source!;
  const roles: string[] = [];
  if (args.worker) roles.push('worker');
  if (args.planner) roles.push('planner');

  console.log(`Installing ${source}...`);
  const result = Bun.spawnSync(['pi', 'install', source], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    console.log(stderr || stdout);
    throw new Error(`pi install failed: ${stderr || stdout}`);
  }
  console.log(stdout || 'Installation successful.');

  if (roles.length) {
    const assignments = prompts.loadPluginAssignments();
    const existing = assignments.plugins.find(plugin => plugin.source === source);
    if (existing) existing.agentRoles = [...new Set([...(existing.agentRoles ?? []), ...roles])];
    else assignments.plugins.push({ source, agentRoles: roles });
    prompts.savePluginAssignments(assignments);
    console.log(`Registered roles ${JSON.stringify(roles)} for ${source}`);
  }
}

function pluginInstallLocal(args: PluginArgs): void {
  const sourcePath = path.resolve(args.path!.replace(/^~/, process.env.HOME ?? ''));
  if (!fs.existsSync(sourcePath)) throw new Error(`extension file not found: ${sourcePath}`);

  const roles: string[] = [];
  if (args.worker) roles.push('worker');
  if (args.planner) roles.push('planner');

  const targetDir = path.join(paths.AGENT_DIR, 'extensions');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(sourcePath));

  let shouldUnlink = fs.existsSync(target);
  if (!shouldUnlink) {
    try {
      shouldUnlink = fs.lstatSync(target).isSymbolicLink();
    } catch {
      shouldUnlink = false;
    }
  }
  if (shouldUnlink) fs.unlinkSync(target);
  try {
    fs.symlinkSync(sourcePath, target);
    console.log(`Linked ${sourcePath} -> ${target}`);
  } catch {
    fs.copyFileSync(sourcePath, target);
    console.log(`Copied ${sourcePath} -> ${target}`);
  }

  if (roles.length) {
    const assignments = prompts.loadPluginAssignments();
    const existing = assignments.plugins.find(plugin => plugin.source === sourcePath);
    if (existing) existing.agentRoles = [...new Set([...(existing.agentRoles ?? []), ...roles])];
    else assignments.plugins.push({ source: sourcePath, agentRoles: roles });
    prompts.savePluginAssignments(assignments);
    console.log(`Registered roles ${JSON.stringify(roles)} for ${path.basename(sourcePath)}`);
  } else {
    console.log('Extension installed. Use --worker or --planner to assign roles.');
  }
}
