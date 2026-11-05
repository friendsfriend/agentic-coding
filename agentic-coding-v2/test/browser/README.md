# Isolated cleanup-panel smoke check

Run `bun test/browser/cleanup-panel.ts` from the v2 directory. Open its printed
`file:` URL in Chromium. It bundles the real definitions panel, but supplies only
canned API responses. No server, credentials, real cleanup, engine or app is used.
Delete the printed temporary directory after closing the page.

This is a manual/exploratory DOM boundary fixture, **not an automated test suite
or a live API integration test**. The native API/reopen scenario remains in
`test/staged-tree.test.ts`. Do not count this fixture as extra passing native tests.

## Checks

- List drafts, then load the selected draft. Its tree summary says CURRENT for
  the loaded snapshot. Set `window.treeMode = 'stale'` in the console and reload
  the draft: it says STALE. With `'absent'`, it says no verified identity.
- Load retained staged-tree metadata. The pending selector discloses an exact
  attempt ID, revision 1, kind and tree digest. Raw history remains inspectable.
- Set `window.acceptConfirmation = false`, then acknowledge. No acknowledgement
  request appears in `window.calls`. Restore it to `true` before continuing.
- Acknowledge. The first request deliberately reports an ambiguous response.
  Reload metadata, then acknowledge again. The two acknowledgement entries in
  `window.calls` must have identical bodies, including requestId, revision and
  explicit acknowledgement. Success clears the pending selection.
- Enter 64 `a` characters as the release digest. Release twice: the first
  response deliberately fails. Both recorded release bodies must be identical.
- Discard local cleanup retries. This sends no server request. A confirmation
  must explain that resetting local state does not retire server uncertainty.
- Read `window.confirmations`: acknowledgement names the exact attempt and
  revision and says that it never deletes, retries, adopts or certifies contents.

Confirmations in this fixture are **auto-accepted and recorded**, not native
operator approvals. The fixture never proves live permission enforcement,
process-kill recovery, remote browser compatibility or publication readiness.
For a real panel, saved retry IDs last only for that mounted panel's lifetime;
inspect native metadata after navigation/reload rather than assuming that a local
retry identity survived.
