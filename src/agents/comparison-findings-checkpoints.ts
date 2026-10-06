import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolDefinition, FreeformInvocation } from '../infrastructure/agent/host.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';

export const isFindingsUpdate = (name: string): boolean => name === 'update_comparison_findings' || name === 'update_comparison_findings_delta';
const sourceTools = new Set(['read', 'ls', 'grep', 'shell_exec', 'render_artifact', 'register_evidence', 'quote_evidence']);
type Phase = 'investigate' | 'review';

export class ComparisonFindingsCheckpoints {
  readonly enabled: boolean;
  readonly #options: ComparisonCompareOptions | undefined;
  #phase: string = '';
  #source = false;
  #saving = false;
  #checks = 0;
  #acceptedState: string | undefined;
  constructor(tools: readonly AgentToolDefinition[], options?: ComparisonCompareOptions) {
    this.#options = options;
    this.enabled = !!options?.getSubmittedResult && options.enforcePhaseBoundaries === true && options.reviewFindings === true
      && typeof options.getFindingsState === 'function' && tools.some(tool => tool.name === 'update_comparison_findings_delta');
  }
  begin(phase: string, pass?: ComparisonWorkPass): void {
    if (phase !== this.#phase) this.#checks = 0;
    this.#phase = phase; this.#saving = this.enabled && pass === 'source-save';
    this.#source = this.enabled && ((phase === 'investigate' && pass === undefined) || pass === 'sources');
    if (this.#saving) this.#acceptedState = undefined;
  }
  due(): boolean { return this.#source && this.#checks >= 6; }
  saved(): boolean { return this.#saving && !!this.#acceptedState && this.#acceptedState === this.#options?.getFindingsState?.(); }
  toolNames(): readonly string[] | undefined { return this.#saving ? ['update_comparison_findings_delta'] : undefined; }
  bind(tools: readonly AgentToolDefinition[], resources?: ComparisonResourceTracker): AgentToolDefinition[] {
    if (!this.enabled) return [...tools];
    return tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
      signal.throwIfAborted();
      resources?.checkHard(tool.name);
      if ((this.#saving && tool.name !== 'update_comparison_findings_delta') || (this.due() && sourceTools.has(tool.name))) return {
        content: JSON.stringify({ code: 'findings_checkpoint_required', message: 'Save this bounded source batch through the bound delta tool. No additional source or report effects may execute until an actual accepted save.' }),
      };
      const result = await tool.execute(params, signal); signal.throwIfAborted();
      if (this.#source && sourceTools.has(tool.name)) this.#checks++;
      if (isFindingsUpdate(tool.name) && /^status=accepted(?:\r?\n|$)/.test(result.content)) {
        this.#checks = 0;
        if (this.#saving) this.#acceptedState = this.#options?.getFindingsState?.();
      }
      return result;
    }, ...(tool.onCompleted ? { onCompleted: async result => {
      if (this.#saving && tool.name !== 'update_comparison_findings_delta') return;
      if (result.content.includes('"code":"findings_checkpoint_required"')) return;
      await tool.onCompleted!(result);
    } } : {}) }));
  }
  async run<P extends Phase>(work: (phase: P, prompt: string, pass?: ComparisonWorkPass) => Promise<FreeformInvocation>, phase: P, prompt: string, pass?: 'sources'): Promise<FreeformInvocation> {
    let outcome = await work(phase, prompt, pass);
    for (let saves = 0; outcome.status === 'yielded' && outcome.reason === 'findings_checkpoint_required' && saves < 5; saves++) {
      const saved = await work(phase, `Save the actual source observations just received now through update_comparison_findings_delta. Use the exact current binding, explicitly retain or replace every existing finding/question ID, and put only new complete objects in addedFindings/addedQuestions. Keep this update small; do not restate prior findings or copy the whole snapshot. Preserve every question identity and decisionImpact. Pending with an actual nextCheck is valid: this intermediate checkpoint does not require ready or certify success. Do not invent missing observations or resolve unchecked relationships. Current saved hypotheses and binding: ${this.#options?.getFindingsState?.() ?? 'unavailable'}`, 'source-save');
      const completed = saved.status === 'completed' || (saved.status === 'yielded' && saved.reason === 'findings_checkpoint_saved');
      if (!completed) return saved;
      if (!this.saved()) return { status: 'failed', sessionId: saved.sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: saves + 1, message: 'The bounded source checkpoint did not save an accepted current findings state.' } };
      if (this.#options?.findingsReady?.()) return { status: 'yielded', sessionId: saved.sessionId, reason: phase === 'investigate' ? 'findings_ready' : 'independent_findings_ready' };
      outcome = await work(phase, `${prompt}\nContinue only the remaining decision-changing source questions after the actual saved checkpoint. Do not repeat settled checks.`, pass);
    }
    return outcome;
  }
}
