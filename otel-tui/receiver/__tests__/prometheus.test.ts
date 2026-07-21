import { describe, it, expect } from 'bun:test';
import { parsePrometheusText } from '../prometheus';

describe('Prometheus parser', () => {
  it('parses gauge metric', () => {
    const text = '# HELP cpu_usage CPU usage\n# TYPE cpu_usage gauge\ncpu_usage{host="web-1"} 42.5\n';
    const metrics = parsePrometheusText(text, 'test');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.name).toBe('cpu_usage');
    expect(metrics[0]!.type).toBe('gauge');
    expect(metrics[0]!.dataPoints[0]!.value).toBe(42.5);
  });

  it('parses counter metric with labels', () => {
    const text = 'http_requests_total{method="GET",status="200"} 1024\n';
    const metrics = parsePrometheusText(text, 'test');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.name).toBe('http_requests_total');
    expect(metrics[0]!.dataPoints[0]!.value).toBe(1024);
  });

  it('parses histogram buckets', () => {
    const text = '# TYPE request_duration histogram\nrequest_duration_bucket{le="0.1"} 5\nrequest_duration_bucket{le="0.5"} 15\nrequest_duration_sum 42.0\n';
    const metrics = parsePrometheusText(text, 'test');
    expect(metrics.length).toBeGreaterThanOrEqual(2);
  });

  it('handles empty text', () => {
    const metrics = parsePrometheusText('', 'test');
    expect(metrics).toEqual([]);
  });
});
