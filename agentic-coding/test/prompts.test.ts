import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import * as prompts from '../src/workflow/prompts.ts';
import { DEFAULT_CONFIG } from './fakes.ts';

describe('rolePrompt', () => {
  test('planner prompt mentions proposal flow', () => {
    const text = prompts.rolePrompt('planner', 'my-change');
    expect(text).toContain('proposal');
    expect(text).toContain('openspec instructions proposal/design/tasks/specs --change my-change');
    expect(text).toContain('openspec validate my-change --strict');
    expect(text).toContain('Do not call generic OpenSpec help');
    expect(text).toContain('herdr-workflow phase proposed --repo . --change my-change');
  });

  test('planner skill contains authoritative OpenSpec commands', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const skill = fs.readFileSync(path.join(root, 'agent-definitions/skills/herdr-openspec-planner/SKILL.md'), 'utf8');
    for (const artifact of ['proposal', 'design', 'tasks', 'specs']) {
      expect(skill).toContain(`openspec instructions ${artifact} --change "$HERDR_CHANGE_ID"`);
    }
    expect(skill).toContain('openspec validate "$HERDR_CHANGE_ID" --strict');
    expect(skill).toContain('Do not inspect archived changes');
  });

  test('worker prompt owns focused tests only', () => {
    const text = prompts.rolePrompt('worker', 'my-change');
    expect(text).toContain('Mark each OpenSpec task');
    expect(text).toContain('Run focused tests only');
    expect(text).toContain('quality and test verifiers own remaining validation gates');
    expect(text).toContain('`triage started:` or `verification already running:` means handoff succeeded');
    expect(text).toContain('never invoke verify again');
    expect(text).toContain('do not poll status');
    expect(text).toContain('workflow phase/base/state blocker');
    expect(text).toContain('never inspect workflow implementation source');
    expect(text).toContain('.herdr-workflow state (herdr.db)');
  });

  test('worker prompt no-openspec has completion instruction', () => {
    const text = prompts.rolePrompt('worker', 'my-change', null, 'no-openspec', 'Fix login');
    expect(text).not.toContain('request.md');
    expect(text).toContain('No task checklist to read');
    expect(text).toContain('herdr-workflow verify --repo . --change my-change');
    expect(text).toContain('`triage started:` or `verification already running:` means handoff succeeded');
    expect(text).toContain('never invoke verify again');
    expect(text).toContain('do not poll status');
    expect(text).toContain('workflow phase/base/state blocker');
    expect(text).toContain('.herdr-workflow state (herdr.db)');
    expect(text).toContain('Fix login');
  });

  test('triage prompt references round and limits AGENTS review', () => {
    const text = prompts.rolePrompt('triage', 'my-change', 2);
    expect(text).toContain('round-2-triage-input.json');
    expect(text).toContain('Do not select agents-verifier merely because AGENTS.md/CLAUDE.md applies');
    expect(text).toContain('instruction file changed or material tooling');
  });

  test('triage prompt stays alive between rounds', () => {
    const text = prompts.rolePrompt('triage', 'my-change', 1);
    expect(text.toLowerCase()).toContain('wait');
    expect(text).not.toContain('do not stay active');
  });

  test('verifier prompt includes complete report API', () => {
    const text = prompts.rolePrompt('security-verifier', 'my-change', 1);
    expect(text).toContain('round-1-security-verifier-context.md');
    expect(text).toContain('round-1-security-verifier.findings.jsonl');
    expect(text).toContain('critical|warning|info');
    expect(text).toContain('Supported record types are finding and verdict only');
    expect(text).toContain('exactly one final');
  });

  test('each verifier has custom silent prompt', () => {
    const expected: Record<string, string> = {
      'security-verifier': 'trust boundaries',
      'agents-verifier': 'AGENTS.md and CLAUDE.md',
      'quality-verifier': 'formatting, lint, and type checks',
      'performance-verifier': 'changed hot paths',
      'openspec-verifier': 'approved proposal, design, specs, and tasks',
      'usability-verifier': 'visual consistency, accessibility, responsive layout',
      'test-verifier': 'complete configured test suite',
    };
    for (const [role, focus] of Object.entries(expected)) {
      const text = prompts.rolePrompt(role, 'my-change', 1);
      expect(text).toContain(focus);
      expect(text).toContain('No chat output');
      expect(text.toLowerCase()).toContain('wait');
      expect(text).not.toContain('do not stay active');
    }
  });

  test('test verifier reuses baseline evidence without extra filtered runs', () => {
    const text = prompts.rolePrompt('test-verifier', 'my-change', 2);
    expect(text).toContain('complete configured test suite once without filters');
    expect(text).toContain('do not rerun changed tests already covered');
    expect(text).toContain('Reuse prior baseline evidence from context');
    expect(text).toContain('one focused baseline reproduction');
    expect(text).toContain('confirmed pre-existing unrelated failures');
  });

  test('specialized verifiers stay within assigned context', () => {
    for (const role of ['security-verifier', 'agents-verifier', 'performance-verifier', 'openspec-verifier', 'usability-verifier']) {
      const text = prompts.rolePrompt(role, 'my-change', 1);
      expect(text).toContain('generated context as authoritative scope');
      expect(text).toContain('no full-repository git diff');
      expect(text).toContain('full assigned files or direct dependencies only');
    }
    expect(prompts.rolePrompt('quality-verifier', 'my-change', 1)).not.toContain('no full-repository git diff');
    expect(prompts.rolePrompt('test-verifier', 'my-change', 1)).not.toContain('no full-repository git diff');
  });

  test('only planner and worker are not silent', () => {
    for (const role of ['planner', 'worker']) {
      expect(prompts.rolePrompt(role, 'my-change').toLowerCase()).not.toContain('silent');
    }
    for (const role of ['triage', 'security-verifier', 'agents-verifier', 'quality-verifier', 'performance-verifier', 'openspec-verifier', 'usability-verifier', 'test-verifier', 'archive', 'recovery']) {
      expect(prompts.rolePrompt(role, 'my-change', 1).toLowerCase()).toContain('silent');
    }
  });

  test('verification commands have one owner', () => {
    for (const role of ['security-verifier', 'agents-verifier', 'performance-verifier', 'openspec-verifier', 'usability-verifier']) {
      expect(prompts.rolePrompt(role, 'my-change', 1)).toContain('Review only; do not run tests, formatting, lint, type, or build commands.');
    }
    expect(prompts.rolePrompt('quality-verifier', 'my-change', 1)).toContain('Do not run any tests');
    expect(prompts.rolePrompt('test-verifier', 'my-change', 1)).toContain('complete configured test suite');
  });

  test('archive prompt reads archive context only', () => {
    const text = prompts.rolePrompt('archive', 'my-change');
    expect(text).toContain('archive-context.md');
    expect(text).toContain('do not stay active'); // archive is terminal, still one-shot
  });

  test('recovery prompt lists allowlisted actions', () => {
    const text = prompts.rolePrompt('recovery', 'my-change');
    expect(text).toContain('retry-verification');
    expect(text).toContain('dispatch-triage');
    expect(text).toContain('record-verifier-result');
  });
});

describe('piArguments', () => {
  test('unrestricted role has no tool restrictions', () => {
    const args = prompts.piArguments('planner', 'model/x', 'high', 'change', DEFAULT_CONFIG);
    const joined = args.join(' ');
    expect(joined).not.toContain('--no-extensions');
    expect(joined).not.toContain('--no-skills');
    expect(joined).not.toContain('--tools');
    expect(joined).toContain('herdr-telemetry.ts');
    expect(joined).toContain('herdr-workflow.ts');
  });

  test('verifier role is restricted', () => {
    expect(prompts.ROLE_TOOLS['usability-verifier']).toBe('read,bash');
    const args = prompts.piArguments('usability-verifier', 'model/x', 'high', 'change', DEFAULT_CONFIG);
    const joined = args.join(' ');
    expect(joined).toContain('--no-extensions');
    expect(joined).toContain('--no-skills');
    expect(joined).toContain('--tools');
    expect(joined).not.toContain('--no-session'); // verifiers now persist across verification rounds
  });

  test('archive role has no context files', () => {
    const args = prompts.piArguments('archive', 'model/x', 'high', 'change', DEFAULT_CONFIG);
    expect(args).toContain('--no-context-files');
  });

  test('worker role is not one-shot', () => {
    const args = prompts.piArguments('worker', 'model/x', 'high', 'change', DEFAULT_CONFIG);
    expect(args).not.toContain('--no-session');
  });

  test('exclusions trigger no-extensions for unrestricted role', () => {
    const config = { ...DEFAULT_CONFIG, plugins: { exclude_extensions: ['some-ext'] } };
    const args = prompts.piArguments('planner', 'model/x', 'high', 'change', config);
    expect(args).toContain('--no-extensions');
    expect(args.join(' ')).toContain('herdr-telemetry.ts');
  });
});

describe('resolveExclusions', () => {
  test('no config returns empty', () => {
    expect(prompts.resolveExclusions({}, 'planner')).toEqual(new Set());
  });

  test('global exclusions apply to any role', () => {
    const config = { plugins: { exclude_extensions: ['a', 'b'] } };
    expect(prompts.resolveExclusions(config, 'planner')).toEqual(new Set(['a', 'b']));
  });

  test('role exclusions merge with global', () => {
    const config = { plugins: { exclude_extensions: ['g'], roles: { worker: { exclude_extensions: ['w'] } } } };
    expect(prompts.resolveExclusions(config, 'worker')).toEqual(new Set(['g', 'w']));
    expect(prompts.resolveExclusions(config, 'planner')).toEqual(new Set(['g']));
  });
});
