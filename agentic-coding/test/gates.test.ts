import { describe, expect, test } from 'bun:test';
import * as gates from '../src/workflow/gates.ts';

describe('evaluatePlanQuality', () => {
  test('all present passes', () => {
    const result = gates.evaluatePlanQuality([], true, 3);
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('missing file reported', () => {
    const result = gates.evaluatePlanQuality(['design'], true, 3);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('missing or empty design.md');
  });

  test('missing specs reported', () => {
    const result = gates.evaluatePlanQuality([], false, 3);
    expect(result.issues).toContain('missing spec scenarios');
  });

  test('no tasks reported', () => {
    const result = gates.evaluatePlanQuality([], true, 0);
    expect(result.issues).toContain('tasks.md has no actionable tasks');
  });

  test('multiple missing artifacts', () => {
    const result = gates.evaluatePlanQuality(['proposal', 'tasks'], false, 0);
    expect(result.issues.length).toBe(4);
  });
});

describe('task parsing', () => {
  test('countTasks', () => {
    const text = '- [ ] one\n- [x] two\n* [X] three\nnot a task\n';
    expect(gates.countTasks(text)).toBe(3);
  });

  test('incompleteTasks detected', () => {
    const text = '- [ ] one\n- [x] two\n';
    const { tasks, incomplete } = gates.incompleteTasks(text);
    expect(tasks.length).toBe(2);
    expect(incomplete).toEqual(['one']);
  });

  test('all complete has no incomplete', () => {
    const text = '- [x] one\n- [X] two\n';
    const { incomplete } = gates.incompleteTasks(text);
    expect(incomplete).toEqual([]);
  });

  test('no tasks present', () => {
    const { tasks, incomplete } = gates.incompleteTasks('just prose, no checklist');
    expect(tasks).toEqual([]);
    expect(incomplete).toEqual([]);
  });
});
