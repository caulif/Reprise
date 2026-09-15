# Claude Code Product Pack

Runtime, history, and projection adapters for Claude Code. Recovery playbook text lives in [`recovery/SKILL.md`](./recovery/SKILL.md). The notes below are for Pack authors, not for the Recovery agent.

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
