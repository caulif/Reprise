import { COMPARISON_SOURCE_TOOLS, isFindingsUpdate, comparisonProtocol } from './comparison-stage-policy.js';
import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolDefinition, AgentToolResult, FreeformInvocation } from '../infrastructure/agent/host.js';

const navigationPaths = new Set([
  'INDEX.md', 'briefing/INDEX.md', 'briefing/decision-map.md', 'briefing/task/initial-input.txt',
  ...['context.json', 'comparison-links.json', 'media.json', 'evidence-index.json'].flatMap(name => [`facts/${name}`, `briefing/facts/${name}`]),
  'briefing/facts/links-diagnostics.json', 'history/INDEX.md', 'history/messages.tsv', 'candidate/INDEX.md',
  ...['process-index.tsv', 'SNAPSHOT.txt', 'git-sink-refs.txt', 'git-sink-manifest.json'].flatMap(name => [`candidate/${name}`, `briefing/candidate/${name}`]),
  'observations/INDEX.md', 'observations/INDEX.tsv', 'observations/user-inputs/INDEX.tsv',
]);
const navigationDirectories = new Set(['briefing', 'briefing/facts', 'briefing/task', 'briefing/candidate', 'facts']);

function countsSourceObservation(name: string, params: unknown): boolean {
  if (!COMPARISON_SOURCE_TOOLS.has(name)) return false;
  if (!['read', 'ls', 'grep'].includes(name) || !params || typeof params !== 'object' || !('path' in params) || typeof params.path !== 'string') return true;
  return !navigationPaths.has(params.path) && !(name === 'ls' && navigationDirectories.has(params.path));
}
type Phase = 'investigate' | 'review';

export class ComparisonFindingsCheckpoints {
  readonly enabled: boolean;
  readonly #options: ComparisonCompareOptions | undefined;
  #phase: string = '';
  #source = false;
  #saving = false;
  #checks = 0;
  #batchStarted = Date.now();
  #acceptedState: string | undefined;
  readonly #sourceDeadline: (() => { at: number } | undefined) | undefined;
  constructor(tools: readonly AgentToolDefinition[], options?: ComparisonCompareOptions,
    sourceDeadline?: () => { at: number } | undefined) {
    this.#options = options;
    this.#sourceDeadline = sourceDeadline;
    this.enabled = comparisonProtocol(options).direct
      && typeof options?.getFindingsState === 'function' && tools.some(tool => tool.name === 'update_comparison_findings_delta');
  }
  begin(phase: string, pass?: ComparisonWorkPass): void {
    if (phase !== this.#phase) { this.#checks = 0; this.#batchStarted = Date.now(); }
    this.#phase = phase; this.#saving = this.enabled && pass === 'source-save';
    this.#source = this.enabled && ((phase === 'investigate' && pass === undefined) || pass === 'sources');
    if (this.#saving) this.#acceptedState = undefined;
  }
  due(): boolean {
    if (!this.#source || this.#checks === 0) return false;
    if (this.#checks >= 6) return true;
    const deadline = this.#sourceDeadline?.();
    if (!deadline || Date.now() >= deadline.at) return false;
    const interval = Math.min(30_000, (deadline.at - this.#batchStarted) / 3);
    return Date.now() - this.#batchStarted >= interval;
  }
  saved(): boolean { return this.#saving && !!this.#acceptedState && this.#acceptedState === this.#options?.getFindingsState?.(); }
  observe(name: string, params: unknown, result: AgentToolResult): void {
    if (!this.enabled) return;
    if (this.#source && countsSourceObservation(name, params)) this.#checks++;
    if (isFindingsUpdate(name) && /^status=accepted(?:\r?\n|$)/.test(result.content)) {
      this.#checks = 0;
      this.#batchStarted = Date.now();
      if (this.#saving) this.#acceptedState = this.#options?.getFindingsState?.();
    }
  }
  async run<P extends Phase>(work: (phase: P, prompt: string, pass?: ComparisonWorkPass) => Promise<FreeformInvocation>, phase: P, prompt: string, pass?: 'sources'): Promise<FreeformInvocation> {
    let outcome = await work(phase, prompt, pass);
    for (let saves = 0; outcome.status === 'yielded' && outcome.reason === 'findings_checkpoint_required' && saves < 5; saves++) {
      const saved = await work(phase, `Save the actual source observations just received now through update_comparison_findings_delta. Use the exact current binding, explicitly retain or replace every existing finding/question ID, and put only new complete objects in addedFindings/addedQuestions. Keep this update small; do not restate prior findings or copy the whole snapshot. Preserve every question identity and decisionImpact. Pending with an actual nextCheck is valid: this intermediate checkpoint does not require ready or certify success. Do not invent missing observations or resolve unchecked relationships. Current saved hypotheses and binding: ${this.#options?.getFindingsState?.() ?? 'unavailable'}`, 'source-save');
      const completed = saved.status === 'completed' || (saved.status === 'yielded' && saved.reason === 'findings_checkpoint_saved');
      if (!completed) return saved;
      if (!this.saved()) return { status: 'failed', sessionId: saved.sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: saves + 1, message: 'The bounded source checkpoint did not save an accepted current findings state.' } };
      if (this.#options?.findingsReady?.()) return { status: 'yielded', sessionId: saved.sessionId, reason: phase === 'investigate' ? 'findings_ready' : 'independent_findings_ready' };
      outcome = await work(phase, 'Continue only the remaining decision-changing source questions after the actual saved checkpoint. Use the task, source material and saved question identities already delivered in this same session, including any audited compaction summary and retained tail. Do not repeat settled checks or reread navigation merely to reconstruct the briefing.', pass);
    }
    return outcome;
  }
}
