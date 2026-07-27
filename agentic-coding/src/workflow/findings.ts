// Pure finding schema validation and cross-verifier consolidation.
import { createHash } from 'node:crypto';

export interface FindingEvent {
  type?: string;
  severity?: string;
  path?: string;
  line?: number;
  detail?: string;
  evidence?: string;
  fix?: string;
  id?: string;
  verdict?: string;
  [key: string]: unknown;
}

export interface Finding {
  id: string;
  severity?: string;
  role: string;
  detail: string;
  path?: string;
  line?: number;
  evidence?: string;
  fix?: string;
  status: string;
  [key: string]: unknown;
}

export function validateReportEvents(events: FindingEvent[], path: string): void {
  if (events.length > 31) throw new Error(`report exceeds 30 findings plus verdict: ${path}`);
  for (const event of events) {
    if (event.type === 'verdict') continue;
    if (event.type !== 'finding') throw new Error(`report contains unsupported record type: ${path}`);
    if (
      !['critical', 'warning', 'info'].includes(event.severity ?? '') ||
      typeof event.path !== 'string' ||
      !Number.isInteger(event.line) ||
      typeof event.detail !== 'string'
    ) {
      throw new Error(`invalid finding schema: ${path}`);
    }
    const limits: Array<[string, number]> = [
      ['detail', 1000],
      ['evidence', 2000],
      ['fix', 1000],
    ];
    for (const [field, limit] of limits) {
      if (field in event) {
        const value = (event as Record<string, unknown>)[field];
        if (typeof value !== 'string' || value.length > limit) {
          throw new Error(`finding ${field} exceeds ${limit} characters: ${path}`);
        }
      }
    }
  }
}

/**
 * Dedupe findings across verifier roles, assign new/unfixed/fixed/accepted status.
 *
 * eventsByRole: {role: [event, ...]} already-loaded JSONL events per role.
 * priorRound: [finding, ...] from the previous round's history (may be empty).
 * acceptedIds: set of finding ids marked accepted by a developer.
 * Returns the flattened findings list (new + prior fixed/unfixed/accepted).
 */
export function consolidate(eventsByRole: Record<string, FindingEvent[]>, priorRound: Finding[], acceptedIds: Set<string>): Finding[] {
  const unique = new Map<string, Finding>();
  for (const [role, events] of Object.entries(eventsByRole)) {
    for (const event of events) {
      if (event.type !== 'finding') continue;
      const detail = String(event.detail ?? '');
      const path = event.path;
      const line = event.line;
      const key = `${path}:${line}:${detail}`.toLowerCase().replace(/\s+/g, ' ');
      const findingId = String(event.id || createHash('sha256').update(key).digest('hex').slice(0, 12));
      if (!unique.has(findingId)) {
        unique.set(findingId, {
          id: findingId,
          severity: event.severity,
          role,
          detail,
          path,
          line,
          evidence: event.evidence,
          fix: event.fix,
          status: 'new',
        });
      }
    }
  }
  const previous = new Set(priorRound.filter(item => item.status === 'new' || item.status === 'unfixed').map(item => item.id));
  const findings: Finding[] = [];
  for (const finding of unique.values()) {
    finding.status = acceptedIds.has(finding.id) ? 'accepted' : previous.has(finding.id) ? 'unfixed' : 'new';
    findings.push(finding);
  }
  for (const prior of priorRound) {
    if (!unique.has(prior.id) && (prior.status === 'new' || prior.status === 'unfixed')) {
      findings.push({ ...prior, status: 'fixed' });
    }
  }
  return findings;
}
