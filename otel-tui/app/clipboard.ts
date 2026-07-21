import { execFileSync } from 'node:child_process';

export function copyText(text: string): boolean {
  if (!text) return false;
  try {
    if (process.platform === 'darwin') execFileSync('pbcopy', [], { input: text });
    else if (process.platform === 'win32') execFileSync('clip', [], { input: text });
    else {
      try { execFileSync('xclip', ['-selection', 'clipboard'], { input: text }); }
      catch { execFileSync('xsel', ['--clipboard', '--input'], { input: text }); }
    }
    return true;
  } catch { return false; }
}
