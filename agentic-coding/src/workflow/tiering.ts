// Pure verification-tiering logic. Git diff text is passed in, never fetched here.
import fs from 'node:fs';
import path from 'node:path';

export const VERIFIER_ROLES = [
  'security-verifier',
  'agents-verifier',
  'quality-verifier',
  'usability-verifier',
  'performance-verifier',
  'openspec-verifier',
] as const;
export const TEST_VERIFIER = 'test-verifier';

const SENSITIVE_RE = /(^|\/)(auth|security|crypto|secret|permission|migration)(\/|$)/i;
const DOCS_RE = /(^|\/)(README|AGENTS|CLAUDE|docs?\/)|\.md$/i;

export function reviewTier(diffNumstat: string, paths: string[]): [string, readonly string[]] {
  const lines = diffNumstat
    .split('\n')
    .filter(row => row && !row.includes('-'))
    .reduce((sum, row) => sum + row.split('\t').slice(0, 2).reduce((a, b) => a + Number(b), 0), 0);
  const sensitive = paths.some(p => SENSITIVE_RE.test(p));
  const docsOnly = paths.length > 0 && paths.every(p => DOCS_RE.test(p));
  if (sensitive || paths.length > 50 || lines > 100) return ['full', VERIFIER_ROLES];
  if (docsOnly && lines <= 10) return ['trivial', ['quality-verifier', 'openspec-verifier']];
  return ['lite', ['security-verifier', 'agents-verifier', 'quality-verifier', 'openspec-verifier']];
}

const UI_SUFFIXES = new Set(['.css', '.scss', '.less', '.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.svg', '.png', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot']);

export function eligibleVerifierRoles(files: string[]): string[] {
  const joined = files.join('\n');
  const eligible = new Set<string>();
  if (files.some(p => !p.endsWith('.md'))) eligible.add('quality-verifier');
  if (SENSITIVE_RE.test(joined)) eligible.add('security-verifier');
  if (files.some(p => ['AGENTS.md', 'CLAUDE.md'].includes(path.basename(p)))) eligible.add('agents-verifier');
  if (files.some(p => p.startsWith('openspec/') || p.endsWith('openapi.yaml') || p.endsWith('openapi.yml'))) eligible.add('openspec-verifier');
  if (
    files.some(p => {
      const ext = path.extname(p).toLowerCase();
      const parts = p.split('/').slice(0, -1);
      const name = path.basename(p);
      return UI_SUFFIXES.has(ext) || parts.some(part => ['frontend', 'ui', 'app'].includes(part)) || /^(theme|colors|tokens)\./i.test(name);
    })
  ) {
    eligible.add('usability-verifier');
  }
  if (/(performance|benchmark|cache|stream|batch|query|algorithm)/i.test(joined)) eligible.add('performance-verifier');
  return [...eligible].sort();
}

export interface FileManifestEntry {
  path: string;
  added: string;
  removed: string;
  hunks: Array<{ id: number; header: string }>;
}

export function fileManifest(diffNumstat: string, diffText: string, files: string[]): FileManifestEntry[] {
  const stats = new Map<string, { added: string; removed: string }>();
  for (const row of diffNumstat.split('\n')) {
    if (!row || !row.includes('\t')) continue;
    const [added, removed, ...rest] = row.split('\t');
    stats.set(rest.join('\t'), { added, removed });
  }
  const hunks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = line.slice(6);
    } else if (current && line.startsWith('@@')) {
      if (!hunks.has(current)) hunks.set(current, []);
      hunks.get(current)!.push(line);
    }
  }
  return files.map(file => ({
    path: file,
    ...(stats.get(file) ?? { added: '?', removed: '?' }),
    hunks: (hunks.get(file) ?? []).slice(0, 8).map((header, index) => ({ id: index + 1, header })),
  }));
}

/** Local AGENTS.md/CLAUDE.md discovery — plain filesystem walk, no git involved. */
export function applicableInstructions(root: string, files: string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(path.join(root, file));
    while (directory === root || directory.startsWith(root + path.sep)) {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const candidate = path.join(directory, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          found.add(path.relative(root, candidate));
        }
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
  }
  return [...found].sort();
}
