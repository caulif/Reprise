# Decision: Recovery M0 maximum-effort forensics and safe diagnostics

Status: accepted

## Context

The original Recovery capability gate skipped a model investigation when a
completed session had no Host-owned preimage or historical event. This prevented
an Agent from checking the isolated workspace, Git state, product history, and
tests for useful weak evidence. Separately, a staging preflight failure was
persisted only as a generic safe summary, which made real-sample failures
impossible to group without exposing paths or raw error text.

## Decision

Recovery now defaults to `maximum-effort-safe`: after isolated staging is
created, it always starts a forensics pass regardless of transcript, Git, or
preimage strength, and always invokes the Recovery Agent. Evidence strength
still controls Provider acceptance and whether a result may be called verified;
it does not control whether investigation occurs.

The event log records `recovery.forensics_started` and
`recovery.forensics_completed` for every staging-backed attempt. The completion
event contains only aggregate, non-sensitive fact counts and Git state. A hard
failure before staging emits `recovery.preflight_failed` with a stable,
desensitized `reasonCode`, `operation`, and `exitCategory`; raw exception text,
paths, and credentials are not persisted.

`maximum-effort-review` and `maximum-effort-aggressive` are exposed as attempt
modes for later candidate and external-evidence policy work. They do not weaken
the current source-directory, path, credential, or Provider-validation limits.

## Consequences

- Empty transcript, non-Git, unborn-Git, no-preimage, and completed-no-tools
  cases consume a bounded Recovery investigation in staging instead of returning
  a synthetic zero-cost result.
- Staging creation remains a hard boundary: no forensics event is possible when
  the isolated workspace does not exist.
- Existing strict manifest and evidence validation remains unchanged, so weak
  evidence cannot silently become verified recovery.

## Verification

`test/codex-experiment.test.ts` covers maximum-effort invocation and forensic
events for empty evidence, while its preflight reverse test covers the
redacted hard-failure diagnostic. `npm run check` is the project gate.