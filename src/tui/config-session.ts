import { configForDraft, emptyHarnessConfigDraft, type HarnessConfigDraft, type HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { handleConfigInput, visibleConfigItems, type ConfigInputResult } from './config-input.js';
import type { ConfigBusy, ConfigConnectionTestStatus } from './pages/config.js';
import type { Locale } from './i18n.js';
import type { Option } from './types.js';

type ConfigSessionState = {
  readonly draft: HarnessConfigDraft;
  readonly selected: number;
  readonly advanced: boolean;
  readonly editing: boolean;
  readonly buffer: string;
  readonly cursor: number;
  readonly pendingToggle: boolean;
  readonly leaveConfirm: boolean;
  readonly busy: ConfigBusy;
  readonly draftVersion: number;
  readonly testStatus: ConfigConnectionTestStatus;
  readonly testDetail: string | undefined;
};

export type ConfigRequestTicket = { readonly kind: 'save' | 'test'; readonly draftVersion: number };

function initialState(draft: HarnessConfigDraft, draftVersion: number): ConfigSessionState {
  return { draft, draftVersion, selected: Math.max(0, visibleConfigItems(draft.kind).indexOf('model')),
    advanced: false, editing: false, buffer: '', cursor: 0, pendingToggle: false, leaveConfirm: false,
    busy: 'idle', testStatus: 'idle', testDetail: undefined };
}

export class ConfigSession {
  #state = initialState(emptyHarnessConfigDraft(), 0);
  #request: ConfigRequestTicket | undefined;
  #dirty: { draft: HarnessConfigDraft; config: HarnessModelConfig; value: boolean } | undefined;

  get state(): ConfigSessionState { return this.#state; }

  reset(draft: HarnessConfigDraft): void {
    this.#state = initialState(draft, this.#state.draftVersion + 1);
    this.#request = undefined;
    this.#dirty = undefined;
  }

  replaceDraft(draft: HarnessConfigDraft): void {
    if (draft === this.#state.draft) return;
    const stale = this.#state.testStatus === 'passed' || this.#state.testStatus === 'failed';
    this.#state = { ...this.#state, draft, draftVersion: this.#state.draftVersion + 1,
      ...(stale ? { testStatus: 'stale', testDetail: undefined } : {}) };
    this.#dirty = undefined;
  }

  dispatch(data: string, input: {
    readonly providers: readonly Option[];
    readonly models: readonly Option[];
    readonly savedConfig: HarnessModelConfig;
    readonly locale: Locale;
  }, refreshModels: (draft: HarnessConfigDraft) => { draft: HarnessConfigDraft; models: readonly Option[] }):
    (Omit<ConfigInputResult, 'state'> & { readonly models: readonly Option[] }) | undefined {
    const result = handleConfigInput({ ...this.#state, providers: input.providers, models: input.models,
      dirty: this.dirty(input.savedConfig), busy: this.#state.busy !== 'idle', locale: input.locale }, data, refreshModels);
    if (!result) return undefined;
    const { state, ...action } = result;
    this.replaceDraft(state.draft);
    this.#state = { ...this.#state, selected: state.selected, advanced: Boolean(state.advanced),
      editing: state.editing, buffer: state.buffer, cursor: state.cursor ?? state.buffer.length,
      pendingToggle: Boolean(state.pendingToggle), leaveConfirm: Boolean(state.leaveConfirm) };
    return { ...action, models: state.models };
  }

  beginRequest(kind: 'save' | 'test'): ConfigRequestTicket | undefined {
    if (this.#state.busy !== 'idle') return undefined;
    const ticket = { kind, draftVersion: this.#state.draftVersion };
    this.#request = ticket;
    this.#state = { ...this.#state, busy: kind,
      ...(kind === 'test' ? { testStatus: 'testing', testDetail: undefined } : {}) };
    return ticket;
  }

  finishRequest(ticket: ConfigRequestTicket): void {
    if (this.#request === ticket) this.#state = { ...this.#state, busy: 'idle' };
  }

  clearTest(): void { this.#state = { ...this.#state, testStatus: 'idle', testDetail: undefined }; }

  completeTest(ticket: ConfigRequestTicket, outcome: 'passed' | 'failed', detail: string): 'ignored' | 'stale' | 'passed' | 'failed' {
    if (this.#request !== ticket) return 'ignored';
    const stale = ticket.draftVersion !== this.#state.draftVersion;
    this.#state = { ...this.#state, testStatus: stale ? 'stale' : outcome,
      testDetail: !stale && outcome === 'failed' ? detail : undefined };
    return stale ? 'stale' : outcome;
  }

  dirty(config: HarnessModelConfig): boolean {
    if (this.#dirty?.draft === this.#state.draft && this.#dirty.config === config) return this.#dirty.value;
    let value: boolean;
    try { value = JSON.stringify(configForDraft(this.#state.draft)) !== JSON.stringify(config); }
    catch { value = true; }
    this.#dirty = { draft: this.#state.draft, config, value };
    return value;
  }
}
