# Decision: Recovery M1 isolated candidate execution and review artifacts

Status: accepted

## Context

Maximum-effort forensics needs several competing recovery hypotheses without
allowing an Agent to contaminate the primary staging workspace or the user
source.  A candidate that cannot be traced to facts and reviewed independently
is not useful when the evidence is weak.

## Decision

Recovery creates an isolated Provider-owned copy for each Host-seeded
hypothesis. The Host selects one deterministic execution candidate before the
Agent runs, exposes its identifier in `RecoveryContext`, and roots every
mutation tool in that candidate rather than the primary staging root.

After a completed envelope, the Host records the selected candidate's
before/after fingerprints and a bounded metadata diff artifact. The artifact
contains relative changed paths and file metadata/hashes, not file bodies. It
also carries the candidate hypothesis and supporting fact references. Sibling
candidates are explicitly discarded; only the selected candidate is copied back
to primary staging for the existing independent Provider validation path.

This is a complete copied snapshot, not filesystem copy-on-write. Source
tripwire, credential, path, and acceptance limits remain unchanged.

## Consequences

- Candidate edits cannot change primary staging before Host selection or leak
  into a competing candidate.
- The model has an accurate description of the workspace it can mutate.
- A review artifact distinguishes changed, added, and removed paths by their
  before/after fingerprint metadata without persisting arbitrary source content.
- The selected candidate is still subject to manifest/evidence validation;
  candidate selection does not make weak evidence `verified`.

## Verification

`test/environment.test.ts` verifies candidate isolation, promotion, and
cross-recovery ownership rejection. `test/codex-experiment.test.ts` verifies
selected-candidate tool execution, source preservation, sibling discard, and
the persisted fingerprint-diff artifact. `npm run check` is the project gate.
