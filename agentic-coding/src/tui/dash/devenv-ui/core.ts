export function isDiffFileAddedOrDeleted(diff: string): boolean {
  return diff.split('\n').some(line => line === '--- /dev/null' || line.startsWith('--- /dev/null\t') || line.startsWith('--- /dev/null ') || line === '+++ /dev/null' || line.startsWith('+++ /dev/null\t') || line.startsWith('+++ /dev/null ') || line.startsWith('new file mode ') || line.startsWith('deleted file mode '));
}
