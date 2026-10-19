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

- Candidate launch planning freezes the selected environment and argv before manifest persistence. The complete environment is consumed without merging process.env; catalog clients use Claude's role selection too. Legacy env remains a trusted local override, not a model tool parameter. CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN and Anthropic authentication/endpoint variables are selected along with standard proxy/CA settings; values and argv are not recorded.
- The manifest records Host configuration and Pack declarations. Only a structured init permissionMode is native evidence; it may arrive after the first message. A mismatch stops further execution without changing permissions. Explicit argv overrides leave the declared mode unknown. Shared user/project configuration and extensions remain unverified; safe mode is never enabled automatically.

- `--strict-mcp-config` isolates MCP only. Skills, agents, slash commands, and memory still load unless `--safe-mode` is used.
- `bypassPermissions` still allows `CronCreate`, `CronDelete`, `ScheduleWakeup`, and `SendMessage` to create durable out-of-workspace effects. Those tools must stay disallowed.
- Candidate runs retain native transcripts in the configured Claude history root; catalog probes still use `--no-session-persistence`. Reprise registers candidate provenance, archives the validated primary JSONL, and groups managed sessions under a read-only Reprise project without changing the candidate workspace or login home. Managed run evidence is not offered as a new replay baseline. The archive does not certify subagent transcripts or external tool-result attachments as complete.

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
