import { describe, it, expect } from 'bun:test';
import { parseStatsDLine, normalizeStatsDMetrics } from '../statsd';

describe('StatsD parser', () => {
  it('parses gauge metric', () => {
    const parsed = parseStatsDLine('cpu.temp:75.5|g');
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('cpu.temp');
    expect(parsed!.value).toBe(75.5);
    expect(parsed!.type).toBe('g');
  });

  it('parses counter with sample rate', () => {
    const parsed = parseStatsDLine('requests:1024|c|@0.5');
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('requests');
    expect(parsed!.value).toBe(1024);
    expect(parsed!.sampleRate).toBe(0.5);
  });

  it('parses timer metric', () => {
    const parsed = parseStatsDLine('response.time:150|ms');
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('ms');
  });

  it('parses tags', () => {
    const parsed = parseStatsDLine('cpu.temp:75.5|g|#host:web-1,env:prod');
    expect(parsed).not.toBeNull();
    expect(parsed!.tags.host).toBe('web-1');
    expect(parsed!.tags.env).toBe('prod');
  });

  it('returns null for empty line', () => {
    expect(parseStatsDLine('')).toBeNull();
    expect(parseStatsDLine('   ')).toBeNull();
  });

  it('returns null for malformed line', () => {
    expect(parseStatsDLine('not-a-metric')).toBeNull();
  });

  it('normalizes multiple lines', () => {
    const metrics = normalizeStatsDMetrics([
      'cpu.temp:75.5|g',
      'cpu.temp:76.0|g',
      'requests:10|c|#app:web',
    ], 'statsd-test');
    expect(metrics).toHaveLength(2); // 2 unique metric+tags combos
    const cpuMetric = metrics.find(m => m.name === 'cpu.temp')!;
    expect(cpuMetric).toBeDefined();
    expect(cpuMetric.dataPoints).toHaveLength(2);
  });
});
