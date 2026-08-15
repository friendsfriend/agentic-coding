import { describe, expect, test } from 'bun:test';
import { registerBuiltins, BUILTIN_CAPABILITIES, BUILTIN_EFFECTS } from '../src/workflow/definitions.ts';
import { WorkflowRegistry, type StepDefinition } from '../src/workflow/registry.ts';
import type { WorkflowSnapshot } from '../src/workflow/contracts.ts';

const contract = { id: 'test.empty', version: 1, parse: () => null };
const reduction = (snapshot: WorkflowSnapshot) => ({ snapshot, effects: [] });
function testStep(id: string, outcomes = ['next']): StepDefinition { return { id, version: 1, label: id, actor: 'system', instructionAssets: [], instructionDigests: [], requirements: [], input: contract, output: contract, outcomes, allowedEffects: [], enter: reduction, reduce: reduction } }

describe('workflow registry', () => {
  test('registers immutable pinned built-ins through public seam', () => {
    const registry = registerBuiltins();
    expect(registry.definitions().filter(item => item.version === 1).map(item => item.id)).toEqual(['standard', 'direct-apply', 'no-openspec']);
    const standard = registry.definition('standard', 1);
    expect(standard.steps).toContain('core.verification');
    expect(() => registry.definition('standard', 1, 'changed')).toThrow(/pin mismatch/);
    expect(Object.isFrozen(standard)).toBe(true);
  });
  test('configured verification policy is pinned as a distinct definition', () => { const registry = registerBuiltins(undefined, 20); const legacy = registry.definition('standard', 1); const configured = registry.definition('standard', 20); expect(configured.digest).not.toBe(legacy.digest); expect(configured.edges.find(edge => edge.from === 'core.verification' && edge.outcome === 'fix')?.loop?.maxAttempts).toBe(20); for (let rounds = 1; rounds <= 20; rounds++) expect(registry.definition('standard', rounds === 6 ? 1 : rounds === 1 ? 21 : rounds)).toBeTruthy(); expect(() => registerBuiltins(undefined, 21)).toThrow('max_verification_rounds') });
  test('rejects dangling, unreachable, undeclared-cycle, and unknown effects', () => {
    expect(() => new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({ ...testStep('bad.version'), version: 0 })).toThrow(/identity/); expect(() => new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({ ...testStep('bad.actor'), actor: 'alien' as never })).toThrow(/actor/); expect(() => new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({ ...testStep('bad.schema'), output: { ...contract, version: 0 } })).toThrow(/contracts/); expect(() => new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep(testStep('bad.outcomes', []))).toThrow(/outcomes/); expect(() => new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES).registerStep({ ...testStep('bad.retry'), retryLimit: 0 })).toThrow(/retry/); expect(() => new WorkflowRegistry(BUILTIN_EFFECTS, []).registerStep({ ...testStep('bad.requirement'), requirements: ['prompt'] })).toThrow(/requirement/);
    const registry = new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES); registry.registerStep(testStep('test.start')); registry.registerStep(testStep('test.end', ['done']));
    expect(() => registry.registerWorkflow({ id: 'bad-dangling', version: 1, label: 'bad', initial: 'test.start', terminal: ['test.end'], steps: ['test.start', 'test.end'], edges: [{ from: 'test.start', outcome: 'next', to: 'missing' }] })).toThrow(/dangling/);
    expect(() => registry.registerWorkflow({ id: 'bad-unreachable', version: 1, label: 'bad', initial: 'test.start', terminal: ['test.end'], steps: ['test.start', 'test.end'], edges: [] })).toThrow();
    const cyclic = new WorkflowRegistry(BUILTIN_EFFECTS, BUILTIN_CAPABILITIES); cyclic.registerStep(testStep('cycle.a')); cyclic.registerStep(testStep('cycle.b'));
    expect(() => cyclic.registerWorkflow({ id: 'bad-cycle', version: 1, label: 'bad', initial: 'cycle.a', terminal: ['cycle.b'], steps: ['cycle.a', 'cycle.b'], edges: [{ from: 'cycle.a', outcome: 'next', to: 'cycle.b' }, { from: 'cycle.b', outcome: 'next', to: 'cycle.a' }] })).toThrow();
    expect(() => new WorkflowRegistry([], BUILTIN_CAPABILITIES).registerStep({ ...testStep('bad.effect'), allowedEffects: ['agent.launch'] })).toThrow(/unknown effect/);
  });
  test('extra registered step never changes existing composition', () => {
    const registry = registerBuiltins(); const before = registry.definition('standard', 1).digest; registry.registerStep(testStep('extension.audit'));
    expect(registry.definition('standard', 1).digest).toBe(before);
    expect(registry.definition('standard', 1).steps).not.toContain('extension.audit'); const composed = registry.registerWorkflow({ id: 'extension-flow', version: 1, label: 'Extension', initial: 'extension.audit', terminal: ['extension.audit'], steps: ['extension.audit'], edges: [] }); expect(composed.steps).toEqual(['extension.audit']);
  });
});
