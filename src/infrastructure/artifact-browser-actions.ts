import { Value } from '@sinclair/typebox/value';
import { RenderBrowserObservationSchema, type RenderBrowserAction, type RenderBrowserObservation } from '../core/schemas/render-browser.js';
import { evaluateJson, type CdpSession } from './artifact-cdp.js';

export async function runBrowserActions(cdp: CdpSession, sessionId: string, actions: readonly RenderBrowserAction[], signal: AbortSignal): Promise<RenderBrowserObservation[]> {
  const observations: RenderBrowserObservation[] = [];
  for (const [actionIndex, action] of actions.entries()) {
    signal.throwIfAborted();
    if (action.kind === 'wait') {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); const reason: unknown = signal.reason; reject(reason instanceof Error ? reason : new Error('Browser action cancelled')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, action.ms);
        signal.addEventListener('abort', abort, { once: true });
      });
    } else if (action.kind === 'key') {
      const key = action.key === 'Space' ? ' ' : action.key;
      const virtualKey = { Enter: 13, Space: 32, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Backspace: 8 }[action.key];
      const event = { key, code: action.key, windowsVirtualKeyCode: virtualKey };
      await cdp.send('Input.dispatchKeyEvent', { ...event, type: 'keyDown', ...(action.key === 'Enter' ? { text: '\r' } : action.key === 'Space' ? { text: ' ' } : {}) }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' }, sessionId);
    } else if (action.kind === 'scroll') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 1, deltaX: action.x, deltaY: action.y }, sessionId);
    } else {
      const observation = await inspectElement(cdp, sessionId, action.selector, actionIndex, action.kind !== 'inspect');
      observations.push(observation);
      if (action.kind === 'inspect') continue;
      if (observation.matched !== 1 || !observation.visible || observation.disabled) throw new Error(`Action ${actionIndex}: selector must identify one visible enabled element`);
      const { x, y, width, height } = observation.rect;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + width / 2, y: y + height / 2, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + width / 2, y: y + height / 2, button: 'left', clickCount: 1 }, sessionId);
      if (action.kind === 'fill') {
        await evaluateJson(cdp, sessionId, `(() => { const e = document.querySelector(${JSON.stringify(action.selector)}); if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)) throw new Error('fill requires input or textarea'); e.focus(); e.select(); return true; })()`);
        await cdp.send('Input.insertText', { text: action.text }, sessionId);
      }
    }
  }
  return observations;
}

async function inspectElement(cdp: CdpSession, sessionId: string, selector: string, actionIndex: number, scroll: boolean): Promise<RenderBrowserObservation> {
  const value = await evaluateJson<unknown>(cdp, sessionId, `(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)}); const e = nodes.length === 1 ? nodes[0] : null;
    if (e && ${String(scroll)}) e.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
    const r = e?.getBoundingClientRect(); const s = e ? getComputedStyle(e) : null;
    return { actionIndex:${actionIndex}, matched:nodes.length, text:(e?.textContent ?? '').slice(0,2000),
      tag:(e?.tagName ?? '').slice(0,128), value:String(e?.value ?? '').slice(0,2000),
      visible:!!r && r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden',
      disabled:!!e?.disabled, checked:!!e?.checked, expanded:e?.getAttribute('aria-expanded')?.slice(0,100) ?? null,
      rect:{x:r?.x ?? 0,y:r?.y ?? 0,width:r?.width ?? 0,height:r?.height ?? 0} };
  })()`);
  if (!Value.Check(RenderBrowserObservationSchema, value)) throw new Error('Invalid browser observation');
  return value;
}
