import { describe, it, expect } from 'bun:test';
import { LogStore } from '../logStore';
import type { LogData } from '../types';

function makeLog(body: string, severity: string, svc: string, traceId?: string): LogData {
  return {
    resource: { attributes: [] },
    scope: { name: 'test', version: '' },
    timeUnixNano: Date.now().toString() + '000000',
    severity,
    body,
    attributes: [],
    traceId,
    serviceName: svc,
  };
}

describe('LogStore', () => {
  it('stores and retrieves logs', () => {
    const store = new LogStore([makeLog('hello', 'INFO', 'web')]);
    expect(store.logCount_).toBe(1);
    expect(store.getLogs()).toHaveLength(1);
  });

  it('filters by body text', () => {
    const store = new LogStore([makeLog('request ok', 'INFO', 'web'), makeLog('error occurred', 'ERROR', 'web')]);
    store.setFilter('error');
    expect(store.filteredCount_).toBe(1);
    expect(store.getLogs()[0]!.body).toBe('error occurred');
  });

  it('filters by service name', () => {
    const store = new LogStore([makeLog('log1', 'INFO', 'web'), makeLog('log2', 'INFO', 'db')]);
    store.setFilter('db');
    expect(store.filteredCount_).toBe(1);
  });

  it('looks up by trace ID', () => {
    const store = new LogStore([
      makeLog('log1', 'INFO', 'web', 'trace1'),
      makeLog('log2', 'INFO', 'web', 'trace1'),
      makeLog('log3', 'INFO', 'db'),
    ]);
    const traceLogs = store.getByTraceId('trace1');
    expect(traceLogs).toHaveLength(2);
  });

  it('handles empty store', () => {
    const store = new LogStore();
    expect(store.logCount_).toBe(0);
    expect(store.getLogs()).toEqual([]);
  });

  it('returns empty for unknown traceId', () => {
    const store = new LogStore([makeLog('log1', 'INFO', 'web')]);
    expect(store.getByTraceId('nonexistent')).toEqual([]);
  });
});
