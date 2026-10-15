import { dispatchCanvasInput, type CanvasFindState } from './page-input.js';
import type { FindRestoreSnapshot } from './timeline-read.js';

type CanvasDispatch = NonNullable<ReturnType<typeof dispatchCanvasInput>>;

export class CanvasFind {
  #state: CanvasFindState = { finding: false, query: '', cursor: 0 };
  #restore: FindRestoreSnapshot | undefined;

  get state(): CanvasFindState { return this.#state; }

  dispatch(data: string, blocked: boolean): Omit<CanvasDispatch, 'state'> | undefined {
    const result = dispatchCanvasInput(this.#state, data, blocked);
    if (!result) return undefined;
    const { state, ...action } = result;
    this.#state = state;
    return action;
  }

  rememberPosition(snapshot: FindRestoreSnapshot): void { this.#restore = snapshot; }

  reset(): FindRestoreSnapshot | undefined {
    const restore = this.#restore;
    this.#state = { finding: false, query: '', cursor: 0 };
    this.#restore = undefined;
    return restore;
  }
}
