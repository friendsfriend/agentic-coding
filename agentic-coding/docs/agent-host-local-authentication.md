# Dashboard-to-host instance authentication

The workflow dashboard uses two independent checks for **every new** control,
catalog or watch connection (including resilient activity/session reconnects):

1. Its off-thread resolver reopens the selected target's authoritative workflow
   store, proves the exact workflow/run membership and runtime directory, and
   checks the recorded socket against that directory's canonical host layout.
   This is not a persistent trust cache or a latest-role substitution.
2. The connected host proves possession of that instance's private key in a
   TLS 1.3 handshake. The client pins the freshly resolved certificate's SHA-256
   fingerprint before sending **any** command frame or accepting session data.
   Commands and responses remain inside that encrypted, authenticated channel.

A host id reported by the endpoint, a pathname-only check, or a bearer token
sent to an unverified listener would not close the verification-to-connect race.
TLS also prevents a transparent forwarding listener from reading command text
or forging session data; such a listener can at most forward encrypted records
or deny service.

## Local identity and filesystem binding

A listening host creates a fresh P-256 key and self-signed X.509 certificate.
The key remains in that process's memory. Node's crypto and TLS implementations
perform signing, authentication, key exchange and record encryption; the small
DER helper only serializes the ephemeral certificate.

Beside the established `host.sock`, the host opens `host-tls.sock` and atomically
publishes **only the public** `host.cert`, mode `0600`, after both listeners are
ready. Its certificate is pinned directly, not validated through a public CA or
DNS hostname. This is local instance authentication, not remote-host PKI.

Certificate lookup walks each path component with `O_NOFOLLOW`, relative to an
already-open directory descriptor. Linux uses `/proc/self/fd`; Darwin binds the
system `openat(2)` API through Bun FFI. A directory rename during the walk cannot
redirect the remaining lookup. The certificate must be a bounded, regular,
owner-controlled private file. Missing native traversal support, symlinks,
missing identities and changed/unexpected peers fail closed. There is no
ordinary-path fallback. A socket or ancestor swap **after** identity resolution
still cannot impersonate the pinned TLS peer.

The trust boundary is the selected target's owner-controlled store/runtime,
not protection against another process already able to replace that user's
private regular files or read its process memory. Existing host-side run and
conversation-ownership checks remain required and unchanged.

## Upgrade and recovery behavior

- **Already-running older hosts:** the new dashboard refuses controls/watches
  when `host.cert` or `host-tls.sock` is absent. It does not silently fall back to
  the legacy plaintext socket. Restart the local host with the upgraded binary
  before opening its session. The existing socket remains for older internal
  clients; the dashboard never uses it for session traffic.
- **Host restart:** the private key and public pin rotate. New connections
  reacquire authoritative ownership and the current certificate, so supported
  recovery uses the new instance rather than retaining an old cached pin.
  A connection racing publication/rotation can fail transiently and must retry;
  accepting an old/unexpected peer is not a recovery strategy.
- **Shutdown:** both listeners and the public certificate are removed, including
  incomplete TLS connections. No private key file needs cleanup.
- **Storage compatibility:** authentication does not change the durable schema
  or the guarded host-store upgrade/backup/restore contract documented in
  `agent-host-storage-upgrade.md`.

## Focused regression coverage

`agent-host-authentication.test.ts` exercises authenticated real-host traffic,
all dashboard control methods, fresh per-connection validation, a deterministic
post-verification directory swap, a substituted watch-reconnect listener,
no-command/no-forged-frame behavior, certificate permissions and a rename during
descriptor-relative certificate traversal. `agent-host-workflow-session.test.ts`
covers fresh instance pins, exact-run rejection and authoritative path changes,
plus actual production-worker disposal/termination during an in-flight lookup.
Darwin's native traversal branch still requires a platform-specific smoke check;
the focused tests in the current implementation environment execute on Linux.
