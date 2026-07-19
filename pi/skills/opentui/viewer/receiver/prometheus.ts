import type { MetricData, MetricDataPoint } from '../model/types';

export interface PromTarget {
  host: string;
  port: number;
}

/**
 * Parse Prometheus text exposition format into MetricData objects.
 * Supports gauge, counter, histogram, and summary.
 */
export function parsePrometheusText(text: string, source: string): MetricData[] {
  const metrics = new Map<string, { help: string; type: string; samples: Array<{ labels: Record<string, string>; value: number }> }>();
  let currentHelp = '';
  let currentType = 'untyped';

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      const helpMatch = trimmed.match(/^#\s+HELP\s+(\S+)\s+(.+)$/);
      if (helpMatch) {
        currentHelp = helpMatch[2]!;
        const name = helpMatch[1]!;
        if (!metrics.has(name)) metrics.set(name, { help: '', type: 'untyped', samples: [] });
        metrics.get(name)!.help = currentHelp;
      }
      const typeMatch = trimmed.match(/^#\s+TYPE\s+(\S+)\s+(\S+)$/);
      if (typeMatch) {
        currentType = typeMatch[2]!;
        const name = typeMatch[1]!;
        if (!metrics.has(name)) metrics.set(name, { help: '', type: 'untyped', samples: [] });
        metrics.get(name)!.type = currentType;
      }
      continue;
    }

    // Parse metric line: name{labels} value [timestamp]
    const sampleMatch = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{(.+?)\}\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    const simpleMatch = !sampleMatch && trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);

    if (sampleMatch) {
      const name = sampleMatch[1]!;
      const labelsStr = sampleMatch[2]!;
      const value = parseFloat(sampleMatch[3]!);
      const labels: Record<string, string> = {};
      for (const pair of labelsStr.split(',')) {
        const [k, v] = pair.split('=').map(s => s.trim().replace(/^"/, '').replace(/"$/, ''));
        if (k && v) labels[k] = v;
      }
      if (!metrics.has(name)) metrics.set(name, { help: '', type: 'untyped', samples: [] });
      metrics.get(name)!.samples.push({ labels, value });
    } else if (simpleMatch) {
      const name = simpleMatch[1]!;
      const value = parseFloat(simpleMatch[2]!);
      if (!metrics.has(name)) metrics.set(name, { help: '', type: 'untyped', samples: [] });
      metrics.get(name)!.samples.push({ labels: {}, value });
    }
  }

  return [...metrics.entries()].map(([name, m]) => {
    const type = m.type === 'counter' || m.type === 'sum' ? 'sum' : m.type === 'histogram' ? 'histogram' : 'gauge';
    const points: MetricDataPoint[] = m.samples.map(s => ({
      startTimeUnixNano: BigInt(Date.now() * 1_000_000).toString(),
      timeUnixNano: BigInt(Date.now() * 1_000_000).toString(),
      value: s.value,
      attributes: Object.entries(s.labels).map(([k, v]) => ({ key: k, value: v })),
    }));
    return {
      resource: { attributes: [{ key: 'service.name', value: source }] },
      scope: { name: 'prometheus', version: '' },
      name,
      description: m.help,
      unit: '',
      type: type as 'gauge' | 'sum' | 'histogram',
      dataPoints: points,
      serviceName: source,
    };
  });
}

/**
 * Scrape a Prometheus endpoint and parse metrics.
 */
export async function scrapePrometheus(target: PromTarget): Promise<MetricData[]> {
  const url = `http://${target.host}:${target.port}/metrics`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`scrape failed: ${res.status}`);
  const text = await res.text();
  return parsePrometheusText(text, `${target.host}:${target.port}`);
}
