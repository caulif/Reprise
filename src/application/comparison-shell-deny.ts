import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";

/** Actionable deny copy for Comparison shell_exec browser probes. */
export const COMPARISON_BROWSER_SHELL_DENIED =
  "Use render_artifact or preview_report; direct browser execution is disabled for Comparison.";

/**
 * Chrome / Edge / Firefox binaries the Comparison agent must not launch via shell_exec.
 * Paths like `...\Application\chrome.exe` and bare `msedge` / `google-chrome` match.
 */
const BROWSER_EXECUTABLE =
  /(?:^|[\s"'`/\\]|&)(?:google-chrome(?:-stable)?|chromium(?:-browser)?|chrome|msedge|microsoft-edge|firefox)(?:\.exe)?(?=$|[\s"'`/\\]|&)/i;

/** Direct browser probe / render flags (do not require the exe name in the same command). */
const BROWSER_PROBE_FLAG =
  /(?:^|[\s"'`])--(?:dump-dom|screenshot|remote-debugging-port)(?:=|\s|$)/i;

/** User profile / default browser session access. */
const BROWSER_USER_PROFILE =
  /(?:^|[\s"'`])--(?:user-data-dir|profile-directory)(?:=|\s|$)|AppData[/\\]Local[/\\](?:Google[/\\]Chrome|Microsoft[/\\]Edge)|Firefox[/\\]Profiles|[/\\]User Data(?:[/\\]|\s|$)/i;

/** True when Comparison shell_exec must fast-reject the command without spawning. */
export function isComparisonBrowserShellCommand(command: string): boolean {
  return BROWSER_EXECUTABLE.test(command) || BROWSER_PROBE_FLAG.test(command) || BROWSER_USER_PROFILE.test(command);
}

/**
 * Wrap Comparison `shell_exec` so browser GUI / probe commands are rejected at the
 * application assembly boundary (not Recovery/Controller global rules).
 * Underlying 60s timeout, killTree, and AbortSignal are unchanged for allowed commands.
 */
export function wrapComparisonShellExec(tool: AgentToolDefinition): AgentToolDefinition {
  if (tool.name !== "shell_exec") return tool;
  return {
    ...tool,
    async execute(params, signal): Promise<AgentToolResult> {
      const command =
        typeof (params as { command?: unknown }).command === "string"
          ? (params as { command: string }).command
          : "";
      if (isComparisonBrowserShellCommand(command)) {
        throw new Error(COMPARISON_BROWSER_SHELL_DENIED);
      }
      return tool.execute(params, signal);
    },
  };
}

/** Apply {@link wrapComparisonShellExec} across a Comparison tool catalog. */
export function withComparisonShellDeny(
  tools: readonly AgentToolDefinition[],
): AgentToolDefinition[] {
  return tools.map(wrapComparisonShellExec);
}
