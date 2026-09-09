# Claude Code Recovery Playbook

Version: claude-code-recovery/v1

This playbook is evidence for Recovery Agent. It does not grant tools or change permissions. Restore the workspace to the conditions before the original Agent received `task.initialInput`. Clear successor artifacts by default; keep or rebuild only what the original task still needs. Do not finish the original task. Short notes may go in `.reprise/recovery-work/`. Start from the Host packet and compare the work copy with `ls`/`grep`/`find`. When a decision-critical sentence is missing from the packet, read `observations/INDEX.md` then one `observations/` file. Do not parse product session JSONL; the Host already froze `TaskCase.initialInput`. The local developer environment may be used for installs and builds; credentials, the user's real directory, and global Git config stay out of bounds.

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

## Report

Write `recovery.md`. Return `ready` when the candidate can start, including when unrelated gaps remain. Return `blocked` when a remaining gap would change the original task.
