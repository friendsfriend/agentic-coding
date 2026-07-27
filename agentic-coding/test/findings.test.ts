import { describe, expect, test } from 'bun:test';
import * as findings from '../src/workflow/findings.ts';

describe('validateReportEvents', () => {
  test('valid finding and verdict pass', () => {
    const events = [
      { type: 'finding', severity: 'warning', path: 'a.py', line: 1, detail: 'x' },
      { type: 'verdict', verdict: 'PASS' },
    ];
    expect(() => findings.validateReportEvents(events, 'report')).not.toThrow();
  });

  test('too many findings rejected', () => {
    const events = Array.from({ length: 31 }, () => ({ type: 'finding', severity: 'info', path: 'a.py', line: 1, detail: 'x' }));
    events.push({ type: 'verdict', verdict: 'PASS' } as any);
    expect(() => findings.validateReportEvents(events as any, 'report')).toThrow();
  });

  test('unsupported type rejected', () => {
    expect(() => findings.validateReportEvents([{ type: 'note' }] as any, 'report')).toThrow();
  });

  test('bad severity rejected', () => {
    expect(() => findings.validateReportEvents([{ type: 'finding', severity: 'urgent', path: 'a.py', line: 1, detail: 'x' }], 'report')).toThrow();
  });

  test('detail over limit rejected', () => {
    const event = { type: 'finding', severity: 'info', path: 'a.py', line: 1, detail: 'x'.repeat(1001) };
    expect(() => findings.validateReportEvents([event], 'report')).toThrow();
  });

  test('evidence over limit rejected', () => {
    const event = { type: 'finding', severity: 'info', path: 'a.py', line: 1, detail: 'x', evidence: 'y'.repeat(2001) };
    expect(() => findings.validateReportEvents([event], 'report')).toThrow();
  });
});

describe('consolidate', () => {
  test('new finding status', () => {
    const eventsByRole = { 'quality-verifier': [{ type: 'finding', severity: 'warning', path: 'a.py', line: 1, detail: 'issue' }] };
    const result = findings.consolidate(eventsByRole, [], new Set());
    expect(result.length).toBe(1);
    expect(result[0].status).toBe('new');
  });

  test('unfixed finding carries forward', () => {
    const eventsByRole = { 'quality-verifier': [{ type: 'finding', id: 'abc123', severity: 'warning', path: 'a.py', line: 1, detail: 'issue' }] };
    const priorRound = [{ id: 'abc123', status: 'new' } as any];
    const result = findings.consolidate(eventsByRole, priorRound, new Set());
    expect(result[0].status).toBe('unfixed');
  });

  test('accepted finding status', () => {
    const eventsByRole = { 'quality-verifier': [{ type: 'finding', id: 'abc123', severity: 'warning', path: 'a.py', line: 1, detail: 'issue' }] };
    const result = findings.consolidate(eventsByRole, [], new Set(['abc123']));
    expect(result[0].status).toBe('accepted');
  });

  test('fixed when missing from new round', () => {
    const priorRound = [{ id: 'abc123', status: 'new', role: 'quality-verifier' } as any];
    const result = findings.consolidate({}, priorRound, new Set());
    expect(result[0].status).toBe('fixed');
  });

  test('dedup same finding across roles', () => {
    const event = { type: 'finding', severity: 'warning', path: 'a.py', line: 1, detail: 'same issue text' };
    const eventsByRole = { 'quality-verifier': [{ ...event }], 'security-verifier': [{ ...event }] };
    const result = findings.consolidate(eventsByRole, [], new Set());
    expect(result.length).toBe(1);
  });

  test('previously fixed finding not reintroduced', () => {
    const priorRound = [{ id: 'abc123', status: 'fixed', role: 'quality-verifier' } as any];
    const result = findings.consolidate({}, priorRound, new Set());
    expect(result).toEqual([]);
  });
});
