# Reprise

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![check](https://github.com/caulif/Reprise/actions/workflows/check.yml/badge.svg)](https://github.com/caulif/Reprise/actions/workflows/check.yml)

> **Experimental.** Reprise is a local-first tool for replaying real coding-agent tasks, running a candidate agent from the same starting point, and inspecting how the results differ.

Use it when one agent session matters enough to revisit: preserve the task context, reconstruct an isolated workspace, try a different candidate runtime, then review the resulting work with its evidence. Reprise is for personal, local experiments. It is not a public leaderboard or a benchmark that proves model quality.

## Demo

<!-- Add a TUI walkthrough or comparison-report screenshot here. -->

_A short TUI walkthrough and a comparison-report screenshot will be added here. The flow is: select a saved session, recover its task starting point, run a candidate, and inspect the result locally._

## What You Get

- **A preserved task case** from a local agent-history session, with recovery findings and known gaps recorded.
- **An isolated candidate run** with an event log, trace, final response, and retained workspace copy.
- **An optional comparison report** that puts historical and candidate evidence side by side instead of reducing them to a single score.

```text
Saved agent session -> recovered task case -> candidate run -> local evidence and comparison report
```

## Quick Start

Reprise currently runs from source. It requires Git, npm, and Node.js **22.19 or later**.

```powershell
git clone https://github.com/caulif/Reprise.git
cd Reprise
npm ci
npm run build
node dist/src/cli/main.js --help
```

The commands above build Reprise and display help only. They do not need a model key or product login, and they do not call a model.

To open the terminal interface, run:

```powershell
node dist/src/cli/main.js
```

Start with `/intake` to select a source product, project, and saved session. Once recovery is complete, select a candidate product and model, review the confirmation screen, and start the run. The [usage guide](./docs/usage.md) covers the full TUI and headless CLI flows.

## Requirements And Support

| What you want to do | What you need |
|---|---|
| Build, inspect help, or run offline checks | The Quick Start prerequisites only |
| Recover a session and run a candidate | A supported product installed locally, with local session history |
| Run recovery, controller, or comparison models | A Harness model configured in `/config`; these operations may incur provider costs |

Windows 11 is the only platform verified with real terminal and Runtime use so far. CI checks do not imply equivalent real-Runtime validation on every operating system. See the [roadmap](./docs/roadmap.md) for validation coverage and remaining work.

The default data directory is `.reprise` in the current directory. Use `--data-dir` or `REPRISE_DATA_DIR` to choose another location.

## Privacy, Cost, And Safety

- Reprise keeps experiments and workspace copies on your machine, but recovery, controller, and comparison requests send task-relevant material to the Harness model service you configure.
- Candidate runtimes use their own product login and data-handling rules. Reprise does not provide a universal network sandbox or roll back external effects.
- Review task input, permissions, privacy, and budget before a real run. Secret filtering is not a guarantee that all personal or business data is removed.

Read [data handling and credentials](./docs/usage.md#数据去向) before using real work, and use test accounts, mocks, or read-only observation for tasks with external side effects.

## Project Status

Reprise is experimental and has not been published to npm yet. The future package name is `@caulif/reprise`; do not install the unrelated unscoped `reprise` package from npm.

Current implementation limits and remaining real Runtime validation are tracked in the [roadmap](./docs/roadmap.md).

## Documentation

| Goal | Read |
|---|---|
| Run Reprise through the TUI or CLI | [Usage guide](./docs/usage.md) |
| Understand modules and execution flow | [Architecture overview](./docs/architecture/overview.md) |
| Set up development and run checks | [Development guide](./docs/development.md) |
| See limitations and validation evidence | [Roadmap](./docs/roadmap.md) |
| Browse the complete documentation map | [Documentation index](./docs/README.md) |

## Support And Contributing / 支持与贡献

For questions and ideas, use [GitHub Discussions](https://github.com/caulif/Reprise/discussions). Report reproducible bugs through [GitHub Issues](https://github.com/caulif/Reprise/issues). Before contributing, read the [contribution guide](./docs/CONTRIBUTING.md), [code of conduct](./docs/CODE_OF_CONDUCT.md), and [development guide](./docs/development.md).

Please do not include credentials, real session content, or unredacted experiment artifacts in public posts.

## Security And License

Report vulnerabilities privately through the [security policy](./docs/SECURITY.md). Reprise is released under the [MIT License](./LICENSE).
