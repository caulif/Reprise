# Claude Code Recovery Playbook

Version: claude-code-recovery/v1

This playbook is evidence for Recovery Agent. It does not grant tools or change permissions. Do not parse product session JSONL; the Host already froze `TaskCase.initialInput` and you must not invent or replace it.

## Where to look

- Historical sessions are `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`.
- Do not reverse a directory slug into a cwd. Read `cwd` from a message row.
- Use `sessionId`, never `session_id`. The two fields diverge.
- `type: user` rows are often `tool_result` blocks, not human prompts.

## Turn and failure signals

- A completed historical turn is `stop_reason === "end_turn"` only. `stop_sequence` is commonly an API error disguise.
- Live turns settle on a `result` frame. There is no reliable `session_state_changed` / idle fallback.
- `subtype: "success"` can coexist with `is_error: true`. Prefer `is_error` and `terminal_reason` over `subtype`.
- `stop_reason` on a live `result` is not a completion signal.

## Control-plane traps

- `claude -p --input-format stream-json --output-format stream-json` without `--verbose` exits 1.
- Never pass `--permission-prompt-tool`. It creates blocking `can_use_tool` requests.
- Never pass `--fallback-model`. It silently changes the model under comparison.
- `--max-turns` does not exist on v2.1.221. The harness enforces `maxTargetTurns`.
- Windows stdin EPIPE crashes the host unless `stdin` has an `error` listener.
- Do not wait for `system/init` before the first user message. Capture it when it arrives.

## Isolation and pollution

- `--strict-mcp-config` isolates MCP only. Skills, agents, slash commands, and memory still load unless `--safe-mode` is used.
- `bypassPermissions` still allows `CronCreate`, `CronDelete`, `ScheduleWakeup`, and `SendMessage` to create durable out-of-workspace effects. Those tools must stay disallowed.
- Candidate runs write `~/.claude/projects` unless `--no-session-persistence` is set. Discovery must also exclude Reprise workspaces and data roots.

## Catalog vs availability

- A model in the `initialize` catalog is not proof it can run. A 403 / debt / auth failure can still follow.
- Catalog `resolvedModel` and init `model` are not equal strings. Init is authoritative for the run fingerprint.
- Historical models such as `deepseek-v4-flash` may be absent from the current catalog. Record them as source evidence; do not invent a substitute candidate.

## Frame sequence for a failed auth turn

1. `system/init`
2. replayed `user` (`isReplay: true`)
3. `assistant` text
4. `result` with `subtype: success`, `is_error: true`, `terminal_reason: api_error`

Treat that sequence as "the candidate never started the task", not as a completed replay.

## Recovery manifest

For `recovered` and `partial`, write `recovery-manifest.json` as well as `recovery.md`. It is the machine-verifiable record: list each candidate-visible changed path exactly once, use only Host-owned evidence refs, and record `beforeHash` / `afterHash` for file content when available. Do not list `.git` metadata. `recovered` requires path-level strong evidence (a matching verified preimage or Git blob); otherwise return `partial` with the uncertainty in `unresolved`.
