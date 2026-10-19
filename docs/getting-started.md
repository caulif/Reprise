# Getting started

[English README](../README.md) · [中文使用指南](./usage.md) · [See a real case first](./examples/pelican.md)

This guide takes you from installation to a result. The maintainer has tested Windows 11 and Linux; macOS has not been tested yet. The [roadmap](./roadmap.md) tracks remaining validation. Most technical reference documents are currently in Chinese.

## Install and inspect help

Install npm and Node.js **22.19 or later**, then run:

```bash
npm install -g @caulif/reprise
reprise --help
```

The help command does not call a model or require a model key or product login. To run from source instead, follow the [README](../README.md#quick-start).

Records default to `.reprise` in the current directory. Use `--data-dir <directory>` or `REPRISE_DATA_DIR` consistently if you need another location; switching directories can make existing records appear absent.

## Configure the two model paths

| Path | Purpose | Configuration |
|---|---|---|
| Reprise model (also called Harness) | Prepare a task, guide the candidate, compare results | Reprise `/config` |
| Candidate tool and model | Execute the recovered task | Install and sign in to Codex or Claude Code separately; choose its model when starting a run |

Configuring one path does not configure the other. Both can incur costs. Reprise does not install candidate tools or change their global model settings.

Open Reprise:

```powershell
reprise --locale en
```

In `/config`, choose **openai-compatible**, then enter your service's base URL, actual model ID, and API key. Choose the API protocol the service supports: `openai-completions` or `openai-responses`. An OpenAI-compatible label does not guarantee support for both protocols. Set reasoning and image input only if your model and service support them. Image input is undeclared/text-only by default; declaring it does not verify visual understanding.

Use arrow keys to select a field and `Enter` to edit it. Some fields are under more settings. Press `Ctrl+S` to save. `Ctrl+T` optionally tests the connection with a model request and may cost money. Saving alone does not test the connection.

The configuration is stored in the Git-ignored `{dataDir}/harness-model.json`. An API key can instead reference an environment variable with `env:NAME`. Never paste a secret into a shell command or a public issue.

For the advanced **pi-catalog** option, install [Pi](https://github.com/badlogic/pi-mono), sign in with `/login` inside Pi, and then choose its catalog entry in Reprise. Pi manages its credentials. Candidate tools still use their own login state; Reprise does not read or save their credential contents.

## Choose a saved task and run it

1. Ensure you have local history from **Codex** or **Claude Code**, and install/authenticate the tool you want to execute the candidate. Both built-in tools support history import and candidate execution; compatibility with every version is not guaranteed.
2. Choose the home action to redo a task, or enter `/intake`. Select the source tool, project, and saved session. Arrow keys navigate; typing filters the session list, `Ctrl+N` loads the next page, and `Ctrl+R` refreshes.
3. Review the task and follow-up instructions. Pressing `Enter` on this review starts task preparation and model calls. It does not re-execute the historical conversation. Preparation may report gaps or block the run if required inputs cannot be recovered.
4. After preparation succeeds, choose the candidate tool. `Esc` lets you review preparation findings and limitations without preparing again.
5. Choose a model from that tool's catalog. `Enter` validates the choice and opens confirmation; it does not yet execute the task. Check the task, prepared workspace, model, and limitations, then confirm execution. A model change discovered during validation requires another confirmation.
6. Follow the running timeline. It displays recorded activity; reading or expanding it does not send a new instruction to the candidate. Press `?` for reading shortcuts.

At the end, the result page shows the outcome and an action to open the execution folder. A folder-open request does not itself prove your file manager displayed the window. Home run history lets you reopen saved runs later.

## Compare and inspect the result

On the result page, choose comparison with the original result when you want a report. **This action starts another model call immediately.** After it finishes, the action leads to the report or failure diagnostics. Use `p` to view the execution process, `d` for technical details, and `Esc` to leave the result view.

A report supports a decision about this task, not a general model ranking. Read missing-evidence and comparability notes alongside its conclusions. Recorded time may cover different scopes; cost is an estimate rather than a provider invoice, and an unknown metric is not zero. The report-analysis model is distinct from the model that executed the task.

The [pelican case](./examples/pelican.md) shows historical deliverables and observations drawn from a saved comparison, with explicit evidence limits. Its preview demonstrates the deliverables, not a recording of a new full run or the current report template.

## Cost and cancellation

Building, printing help, and ordinary offline development checks do not call a model. Preparing a task, running a candidate with Reprise guidance, generating a comparison, and testing the model connection can incur charges. Developer smoke-test opt-in flags do not make user-triggered TUI runs free.

The normal CLI/TUI has no independent budget-setting screen. Recovery and Comparison default to a 24-hour overall time budget; Comparison has no default request/tool-count cap. Controller's overall deadline depends on the configured run policy rather than that 24-hour default. These are not monetary caps. Even an explicitly configured integration cost limit cannot precisely cap an in-flight request. See the [budget reference](./architecture/evidence-and-comparison.md#comparison-attempt) (Chinese) for advanced integration settings.

During a running stage, press `Ctrl+C` to request cancellation. From another terminal, you can also use a saved operation, experiment, or run ID:

```text
node dist/src/cli/main.js cancel <operationId|experimentId|runId>
```

Use the same data directory. Wait for terminal status and cleanup diagnostics; cancellation is a request, and cleanup can take time or remain unconfirmed. Reprise does not undo changes to external services. Start with a small, non-sensitive task whose external effects you can control.

## Data and permissions

Task cases, event logs, traces, workspace copies, reports, and local configuration are saved on your machine. Preparation, guidance, and comparison send task-relevant material to the configured Reprise model service. Candidate data handling follows the candidate tool's service and account rules.

Secret filtering is not a guarantee that every private detail is removed. Inspect text, screenshots, paths, and deliverables before sharing. Do not publish the entire `.reprise` directory.

A separate workspace is not an operating-system filesystem or network sandbox. Use test accounts, mocks, or read-only observation for tasks involving deployment, databases, purchases, or other external effects. If the task cannot be replayed safely, cancel it. Recovery gaps and unknown historical settings remain limitations rather than being silently treated as identical conditions.

## Troubleshooting

| Symptom | Next step |
|---|---|
| `reprise` is not found | Use `node dist/src/cli/main.js` from the checkout; run `npm run build` if `dist/` is missing. |
| Tool is unavailable | Install the selected tool and ensure it is on PATH. The executable overrides are `REPRISE_CODEX_EXECUTABLE` and `REPRISE_CLAUDE_EXECUTABLE`; Reprise does not install tools. |
| No projects or sessions | Confirm that the source tool has saved local history. Refresh the list and check filtering. Reprise cannot invent a historical session. |
| Model connection fails | Recheck base URL, API protocol, model ID, and credential source in `/config`. A connection test may cost money; share only the redacted error summary. |
| Preparation is blocked | Inspect the missing inputs and preparation findings. There is no force-through switch for blocked recovery. |
| No report or media | Check whether comparison was requested, whether media was captured, and whether the report failed or a snapshot is missing. An absent report is not a successful comparison. |
| Cancellation is still pending | Check the final state and cleanup diagnostics; do not infer completion from the keypress alone. |
| A repeated run fails | Preserve the failed run's diagnostics and check the [roadmap](./roadmap.md). Repeat runs are implemented and tested with fake runtimes; real-Runtime coverage remains incomplete. Do not delete the entire data directory as a default repair. |

Ask for help through [GitHub Issues](https://github.com/caulif/Reprise/issues/new/choose) in English or Chinese. Include OS, Node and tool versions, steps, and a redacted error. Report vulnerabilities through the [security policy](./SECURITY.md), not a public issue. Full CLI and technical details are in the [Chinese usage guide](./usage.md).
