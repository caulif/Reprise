# Install and configure Reprise with an agent

Follow this guide when a user asks you to install and configure Reprise. Finish with a usable configuration and brief usage examples. Do not start a historical task during setup.

## Check and install

1. Check Node.js, npm, and `reprise --version`. Reprise requires Node.js 22.19 or later; check the published package requirements before installing. Explain a missing prerequisite rather than silently changing system-wide settings.
2. Install `@caulif/reprise` from npm if needed. Keep an existing compatible installation. Use `reprise --help` and `reprise config --help` to verify the installed command surface; do not invent setup commands.
3. Choose a user-owned data directory outside repositories, shared folders, and cloud-synced directories. Use the same explicit `--data-dir` for every subsequent command. Do not change global environment variables. Reuse an existing directory when the user identifies one.
4. Inspect configuration using `reprise config get --data-dir <directory> --json`. Do not open existing credential files. Reuse a complete configuration unless the user asks to change it; explain the replacement before overwriting existing settings. Configuration presence is not proof of connectivity.

## Guide local file configuration

Explain the two model paths briefly: the Reprise model prepares tasks, guides execution, and compares results; Codex or Claude Code executes the task using its own installation and login. Configure the Reprise model now. Execution-tool login can be completed when needed, without reading its credentials.

Ask for the service endpoint and model ID, and clarify the API protocol if needed. These can be supplied in conversation provided they contain no credentials. Never ask the user to paste an API key into chat.

The existing CLI supports importing a key from a file:

1. Create a new, empty key-input file in the chosen private directory, without overwriting any existing file. Tell the user its exact path and ask them to enter only the key in their local editor and save it. Do not read the file after handoff or capture the editor contents.
2. After the user confirms saving, use `reprise config set` with `--kind openai-compatible`, `--base-url`, `--model`, the appropriate `--api` (`openai-completions` or `openai-responses`), `--api-key-file <path>`, and the same `--data-dir`. The application reads the key internally; never substitute the file contents into shell arguments. Quote paths and non-secret values appropriately for the user's shell. The `reprise models` command lists execution-tool models, not the custom Reprise provider's catalog; ask for a real model ID rather than choosing an unrelated entry.
3. This imports the key into Reprise's existing configuration file. Explain that both files contain plaintext credentials. Offer to remove the temporary input file after successful import, with the user's agreement; never remove unrelated files.

If the user prefers editing all settings in one file, first verify the configuration format for the installed release from its source or documentation. Create a template only if the file does not exist, using placeholders rather than real credentials. Do not guess a persistence format or replace existing configuration. After handoff, the user edits it and the agent only uses public configuration commands to inspect status. Do not treat placeholder values as a completed configuration.

Use user-private file permissions where supported. Do not claim the file is encrypted or inaccessible to other programs running as the same user. Do not print keys, key fragments, credential-bearing URLs, or complete configuration files. If an error could include submitted content, report a safe failure category rather than quoting it. Never troubleshoot by reading the filled file, dumping environment variables, or inspecting Codex/Claude Code credential files.

## Check and finish

- Use `config get` to check the public configuration state, including whether credentials are present. Do not infer connectivity from that result or from exit code zero alone.
- Offer a connection test only when an applicable command or documented workflow exists in the installed version. Explain that it sends a request and may cost money; follow the user's authorization. Do not use image probing, task recovery, or a candidate run as a substitute. The published 0.1.0 CLI has no general `config test` command; report connectivity as untested if no suitable non-TUI path is available.
- Do not install a Reprise Skill unless a real, compatible Skill has been published. This guide does not assume one exists.
- Finish by reporting the installed version, data directory, configuration status, and whether connectivity was tested. Provide the launch command using the same directory: `reprise --data-dir <directory>`.
- Give one or two examples in the user's language, such as “Use Reprise to find yesterday's pelican-animation Codex session and show me the available models for redoing it” or “Redo my path-recognition fix with Reprise and compare the deliveries.” Resolve ambiguous sessions before execution and follow the user's actual authorization for paid operations.

Detailed operating instructions: [usage guide](./usage.md) and [getting started](./getting-started.md).
