import { describe, expect, test } from 'bun:test';
import * as transitions from '../src/workflow/transitions.ts';

describe('transitions', () => {
  test('standard allows full lifecycle', () => {
    const state = { workflowModules: transitions.WORKFLOW_TYPES.standard };
    const allowed = transitions.allowedTransitions(state);
    expect(allowed.explore.has('proposed')).toBe(true);
    // "proposed" is a gate module (developer approval): allowedTransitions leaves it
    // with no outgoing edge; proposed -> apply is enforced by the dedicated `apply`
    // subcommand instead, not the generic `phase` transition.
    expect(allowed.proposed).toEqual(new Set());
    expect(allowed.apply.has('verify')).toBe(true);
    expect(allowed.verify).toEqual(new Set(['fix', 'paused', 'developer-review']));
    expect(allowed.verify.has('developer-review')).toBe(true);
    // developer-review is also a gate (developer approval); its outgoing edge is
    // enforced by the dedicated `archive` subcommand, not this table.
    expect(allowed['developer-review']).toEqual(new Set());
    expect(allowed.archive.has('committing')).toBe(true);
    expect(allowed.committing.has('completed')).toBe(true);
  });

  test('direct-apply skips planning', () => {
    const state = { workflowModules: transitions.WORKFLOW_TYPES['direct-apply'] };
    const allowed = transitions.allowedTransitions(state);
    expect(allowed.explore).toBeUndefined();
    expect(allowed.apply).toBeDefined();
    expect(allowed.apply.has('verify')).toBe(true);
  });

  test('no-openspec skips archive', () => {
    const modules = transitions.WORKFLOW_TYPES['no-openspec'];
    const allowed = transitions.allowedTransitions({ workflowModules: modules });
    expect(modules).not.toContain('archive');
    expect(allowed.archive).toBeUndefined();
    expect(allowed.committing.has('completed')).toBe(true);
  });

  test('verify/fix/paused loop', () => {
    const state = { workflowModules: transitions.WORKFLOW_TYPES.standard };
    const allowed = transitions.allowedTransitions(state);
    expect(allowed.fix).toEqual(new Set(['verify']));
    expect(allowed.paused).toEqual(new Set(['fix', 'verify']));
  });

  test('invalid transition absent', () => {
    const state = { workflowModules: transitions.WORKFLOW_TYPES.standard };
    const allowed = transitions.allowedTransitions(state);
    expect(allowed.explore?.has('completed')).toBeFalsy();
  });

  test('resolveModules defaults to standard', () => {
    expect(transitions.resolveModules({})).toEqual([...transitions.WORKFLOW_TYPES.standard]);
  });
});
