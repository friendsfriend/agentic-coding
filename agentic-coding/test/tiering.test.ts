import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import * as tiering from '../src/workflow/tiering.ts';

describe('reviewTier', () => {
  test('lite default', () => {
    const [tier, roles] = tiering.reviewTier('5\t2\tsrc/foo.py\n', ['src/foo.py']);
    expect(tier).toBe('lite');
    expect(new Set(roles)).toEqual(new Set(['security-verifier', 'agents-verifier', 'quality-verifier', 'openspec-verifier']));
  });

  test('sensitive path forces full', () => {
    const [tier, roles] = tiering.reviewTier('1\t1\tsrc/auth/login.py\n', ['src/auth/login.py']);
    expect(tier).toBe('full');
    expect(new Set(roles)).toEqual(new Set(tiering.VERIFIER_ROLES));
  });

  test('more than 50 files forces full', () => {
    const paths = Array.from({ length: 51 }, (_, i) => `src/file${i}.py`);
    const [tier] = tiering.reviewTier('', paths);
    expect(tier).toBe('full');
  });

  test('more than 100 lines forces full', () => {
    const [tier] = tiering.reviewTier('60\t50\tsrc/foo.py\n', ['src/foo.py']);
    expect(tier).toBe('full');
  });

  test('docs only under 10 lines is trivial', () => {
    const [tier, roles] = tiering.reviewTier('3\t2\tREADME.md\n', ['README.md']);
    expect(tier).toBe('trivial');
    expect(new Set(roles)).toEqual(new Set(['quality-verifier', 'openspec-verifier']));
  });

  test('docs only over 10 lines is lite not trivial', () => {
    const [tier] = tiering.reviewTier('30\t20\tREADME.md\n', ['README.md']);
    expect(tier).toBe('lite');
  });

  test('binary rows excluded from line count', () => {
    const [tier] = tiering.reviewTier('-\t-\tsrc/image.png\n', ['src/image.png']);
    expect(tier).toBe('lite');
  });
});

describe('eligibleVerifierRoles', () => {
  test('code file gets quality', () => {
    expect(tiering.eligibleVerifierRoles(['src/foo.py'])).toContain('quality-verifier');
  });

  test('md only skips quality', () => {
    expect(tiering.eligibleVerifierRoles(['docs/readme.md'])).not.toContain('quality-verifier');
  });

  test('security path triggers security-verifier', () => {
    expect(tiering.eligibleVerifierRoles(['src/security/token.py'])).toContain('security-verifier');
  });

  test('AGENTS.md triggers agents-verifier', () => {
    expect(tiering.eligibleVerifierRoles(['skills/AGENTS.md'])).toContain('agents-verifier');
  });

  test('openspec path triggers openspec-verifier', () => {
    expect(tiering.eligibleVerifierRoles(['openspec/changes/x/tasks.md'])).toContain('openspec-verifier');
  });

  test('performance keyword triggers performance-verifier', () => {
    expect(tiering.eligibleVerifierRoles(['src/cache/query_batch.py'])).toContain('performance-verifier');
  });

  test('UI files trigger usability-verifier', () => {
    for (const path of ['src/Button.tsx', 'nested/ui/dialog.py', 'frontend/api.py', 'app/state.py', 'theme.config.ts', 'assets/logo.svg']) {
      expect(tiering.eligibleVerifierRoles([path])).toContain('usability-verifier');
    }
  });

  test('unrelated file triggers nothing extra', () => {
    expect(tiering.eligibleVerifierRoles(['docs/readme.md'])).toEqual([]);
  });
});

describe('fileManifest', () => {
  test('manifest includes stats and hunks', () => {
    const numstat = '3\t1\tsrc/foo.py\n';
    const diff = 'diff --git a/src/foo.py b/src/foo.py\n+++ b/src/foo.py\n@@ -1,2 +1,3 @@\n+new line\n';
    const manifest = tiering.fileManifest(numstat, diff, ['src/foo.py']);
    expect(manifest[0].path).toBe('src/foo.py');
    expect(manifest[0].added).toBe('3');
    expect(manifest[0].removed).toBe('1');
    expect(manifest[0].hunks.length).toBe(1);
  });

  test('manifest caps hunks at 8', () => {
    const diff = '+++ b/src/foo.py\n' + Array.from({ length: 12 }, (_, i) => `@@ -${i},0 +${i},1 @@\n`).join('');
    const manifest = tiering.fileManifest('', diff, ['src/foo.py']);
    expect(manifest[0].hunks.length).toBe(8);
  });

  test('missing stats default to unknown', () => {
    const manifest = tiering.fileManifest('', '', ['src/new.py']);
    expect(manifest[0].added).toBe('?');
    expect(manifest[0].removed).toBe('?');
  });
});

describe('applicableInstructions', () => {
  test('finds AGENTS.md up the tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiering-'));
    try {
      fs.mkdirSync(path.join(root, 'src', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'AGENTS.md'), 'rules');
      expect(tiering.applicableInstructions(root, ['src/pkg/mod.py'])).toEqual(['src/AGENTS.md']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('no instructions found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiering-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      expect(tiering.applicableInstructions(root, ['src/mod.py'])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
