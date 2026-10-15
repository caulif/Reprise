import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";

/** Actionable deny copy for Comparison command browser probes. */
export const COMPARISON_BROWSER_SHELL_DENIED =
  "Use render_artifact or preview_report; direct browser execution is disabled for Comparison.";

/**
 * Chrome / Edge / Firefox binaries the Comparison agent must not launch via exec_command.
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

/** True when Comparison must fast-reject the command without spawning. */
export function isComparisonBrowserShellCommand(command: string): boolean {
  return BROWSER_EXECUTABLE.test(command) || BROWSER_PROBE_FLAG.test(command) || BROWSER_USER_PROFILE.test(command);
}

/**
 * Wrap Comparison `exec_command` so browser GUI / probe commands are rejected at the
 * application assembly boundary (not Recovery/Controller global rules).
 * Returns a normal tool result (does not throw) so Host→Pi keeps the actionable
 * guidance in model-visible content; throwing would be rewritten to a generic
 * `AgentToolFailure` message that hides render_artifact / preview_report.
 * Owner and lifecycle remain attached so allowed commands retain managed cleanup.
 */
function wrapComparisonShellExec(tool: AgentToolDefinition): AgentToolDefinition {
  if (tool.name !== "exec_command" && tool.name !== "write_stdin") return tool;
  return {
    ...tool,
    async execute(params, signal, owner): Promise<AgentToolResult> {
      const command = tool.name === 'exec_command' ? (params as { cmd?: unknown }).cmd : (params as { chars?: unknown }).chars;
      if (typeof command === 'string' && isComparisonBrowserShellCommand(command)) {
        return {
          content: COMPARISON_BROWSER_SHELL_DENIED,
          details: { denied: true, code: "browser_shell_denied" },
        };
      }
      return tool.execute(params, signal, owner);
    },
  };
}

/** Apply Comparison browser-shell deny across a Comparison tool catalog. */
export function withComparisonShellDeny(
  tools: readonly AgentToolDefinition[],
): AgentToolDefinition[] {
  return tools.map(wrapComparisonShellExec);
}
