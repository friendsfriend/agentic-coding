import type { MetricData, MetricDataPoint } from '../model/types';

interface StatsDParsed {
  name: string;
  value: number;
  type: string;
  sampleRate?: number;
  tags: Record<string, string>;
}

/**
 * Parse a StatsD line protocol datagram.
 * Format: <metricname>:<value>|<type>[|@<sample_rate>][|#<tag1:value1>,<tag2:value2>]
 */
export function parseStatsDLine(line: string): StatsDParsed | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // metric:value|type|@rate|#tags
  const mainMatch = trimmed.match(/^([^:]+):([-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\|(\w+)/);
  if (!mainMatch) return null;

  const name = mainMatch[1]!;
  const value = parseFloat(mainMatch[2]!);
  const type = mainMatch[3]!;

  // Optional sample rate
  const rateMatch = trimmed.match(/\|@([\d.]+)/);
  const sampleRate = rateMatch ? parseFloat(rateMatch[1]!) : undefined;

  // Optional tags
  const tags: Record<string, string> = {};
  const tagMatch = trimmed.match(/\|#(.+)$/);
  if (tagMatch) {
    for (const pair of tagMatch[1]!.split(',')) {
      const [k, v] = pair.split(':').map(s => s.trim());
      if (k) tags[k] = v ?? 'true';
    }
  }

  return { name, value, type: type.toLowerCase(), sampleRate, tags };
}

/**
 * Normalize StatsD line protocol metrics to MetricData objects.
 */
export function normalizeStatsDMetrics(lines: string[], source: string): MetricData[] {
  const aggregator = new Map<string, MetricData>();

  for (const line of lines) {
    const parsed = parseStatsDLine(line);
    if (!parsed) continue;

    const key = `${parsed.name}:${Object.entries(parsed.tags).sort().map(([k, v]) => `${k}=${v}`).join(',')}`;
    const existing = aggregator.get(key);

    const tagAttrs = Object.entries(parsed.tags).map(([k, v]) => ({ key: k, value: v }));
    const point: MetricDataPoint = {
      startTimeUnixNano: BigInt(Date.now() * 1_000_000).toString(),
      timeUnixNano: BigInt(Date.now() * 1_000_000).toString(),
      value: parsed.value,
      attributes: tagAttrs,
    };

    if (existing) {
      existing.dataPoints.push(point);
    } else {
      const otelType = parsed.type === 'g' || parsed.type === 'c' ? 'gauge' : parsed.type === 'ms' || parsed.type === 'h' ? 'sum' : 'gauge';
      aggregator.set(key, {
        resource: { attributes: [{ key: 'service.name', value: source }] },
        scope: { name: 'statsd', version: '' },
        name: parsed.name,
        description: '',
        unit: parsed.type === 'ms' ? 'ms' : '',
        type: otelType as 'gauge' | 'sum' | 'histogram',
        dataPoints: [point],
        serviceName: source,
      });
    }
  }

  return [...aggregator.values()];
}
