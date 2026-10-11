import { Value } from '@sinclair/typebox/value';
import { RenderGeometryQueriesSchema, RenderGeometrySampleSchema, RENDER_GEOMETRY_MAX_SAMPLE_BYTES, type RenderGeometryQuery, type RenderGeometrySample } from '../core/schema.js';
import { evaluateJson, type CdpSession } from './artifact-cdp.js';

export function validGeometryQueries(queries: readonly RenderGeometryQuery[]): boolean {
  return Value.Check(RenderGeometryQueriesSchema, queries) && new Set(queries.map(query => query.name)).size === queries.length;
}

export async function createGeometryWorld(session: CdpSession, pageSessionId: string): Promise<number> {
  const tree = await session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, pageSessionId);
  const world = await session.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id, worldName: 'reprise-host-geometry', grantUniveralAccess: false,
  }, pageSessionId);
  if (!Number.isInteger(world.executionContextId)) throw new Error('geometry isolated world unavailable');
  return world.executionContextId;
}

export function validateGeometrySample(value: unknown, queries: readonly RenderGeometryQuery[], earliestMs: number): RenderGeometrySample {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > RENDER_GEOMETRY_MAX_SAMPLE_BYTES || !Value.Check(RenderGeometrySampleSchema, value)) {
    throw new Error('invalid geometry sample or byte budget exceeded');
  }
  if (value.startedAtMs < earliestMs || value.finishedAtMs < value.startedAtMs || value.observations.length !== queries.length) throw new Error('geometry timing or query count mismatch');
  value.observations.forEach((observation, index) => {
    const query = queries[index]!;
    if (observation.name !== query.name || observation.selector !== query.selector || observation.kind !== query.kind) throw new Error('geometry query binding mismatch');
    if (observation.status !== 'ok') {
      const diagnostic = observation.selectorDiagnostics;
      if (diagnostic && ((observation.status !== 'missing' && observation.status !== 'ambiguous')
        || (observation.status === 'missing' ? diagnostic.matchCount !== 0 : diagnostic.matchCount < 2)
        || diagnostic.candidates.length !== Math.min(4, diagnostic.matchCount))) throw new Error('geometry selector diagnostic mismatch');
      return;
    }
    const names = observation.kind === 'dom_rect' ? ['top_left', 'top_right', 'bottom_right', 'bottom_left']
      : observation.tagName === 'line' || observation.tagName === 'path' ? ['start', 'end']
      : observation.tagName === 'circle' || observation.tagName === 'ellipse' ? ['center', 'x_radius', 'y_radius'] : [];
    if (!names.length || observation.screenPoints.length !== names.length || observation.screenPoints.some((point, i) => point.name !== names[i])) throw new Error('geometry point mapping mismatch');
    if (observation.kind === 'dom_rect') {
      const { x, y, width, height } = observation.bounds;
      const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
      if (observation.screenPoints.some((point, i) => Math.abs(point.x - corners[i]![0]!) > 1e-6 || Math.abs(point.y - corners[i]![1]!) > 1e-6)) throw new Error('geometry rectangle mapping mismatch');
    }
    if (observation.kind === 'svg_geometry') {
      if (observation.localPoints.length !== names.length) throw new Error('geometry local point mapping mismatch');
      observation.localPoints.forEach((point, i) => {
        const screen = observation.screenPoints[i]!;
        const { a, b, c, d, e, f } = observation.matrix;
        const x = a * point.x + c * point.y + e;
        const y = b * point.x + d * point.y + f;
        if (point.name !== names[i] || Math.abs(screen.x - x) > 1e-6 * Math.max(1, Math.abs(x)) || Math.abs(screen.y - y) > 1e-6 * Math.max(1, Math.abs(y))) throw new Error('geometry transform mapping mismatch');
      });
    }
  });
  return value;
}

export async function collectGeometrySample(session: CdpSession, pageSessionId: string, contextId: number, queries: readonly RenderGeometryQuery[], originMs: number, earliestMs: number, signal: AbortSignal): Promise<RenderGeometrySample> {
  if (signal.aborted) throw new Error('cancelled during geometry sample');
  const value = await evaluateJson<unknown>(session, pageSessionId, geometryExpression(queries, originMs), contextId);
  if (signal.aborted) throw new Error('cancelled during geometry sample');
  return validateGeometrySample(value, queries, earliestMs);
}

// Runs only in a fresh isolated world: artifact scripts cannot replace these native DOM APIs.
function geometryExpression(queries: readonly RenderGeometryQuery[], originMs: number): string {
  return `(() => {
    const startedAtMs = performance.now() - ${originMs};
    const finite = values => values.every(v => Number.isFinite(v) && Math.abs(v) <= 1e9);
    const point = (name,x,y) => ({name,x,y});
    const observations = ${JSON.stringify(queries)}.map(query => {
      let nodes;
      try { nodes = document.querySelectorAll(query.selector); }
      catch { return {...query,status:'invalid_selector'}; }
      if (nodes.length !== 1) return {...query,status:nodes.length ? 'ambiguous' : 'missing',selectorDiagnostics:{
        matchCount:nodes.length,candidates:Array.from({length:Math.min(nodes.length,4)},(_,i) => nodes[i]).map(node => ({tagName:node.localName.slice(0,64),elementId:node.id.slice(0,64),parentId:(node.parentElement?.id ?? '').slice(0,64)}))}};
      const node = nodes[0];
      const base = {...query,tagName:node.localName.slice(0,64),elementId:node.id.slice(0,64),parentId:(node.parentElement?.id ?? '').slice(0,64)};
      try {
        const style = getComputedStyle(node);
        if (!node.isConnected || !node.getClientRects().length || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return {...base,status:'unavailable'};
        if (style.transform !== 'none' && !new DOMMatrixReadOnly(style.transform).is2D) return {...base,status:'unsupported'};
        for (let parent=node.parentElement; parent; parent=parent.parentElement) {
          const s=getComputedStyle(parent);
          if (s.display==='none' || s.visibility!=='visible' || Number(s.opacity)===0) return {...base,status:'unavailable'};
          if (s.transform !== 'none' && !new DOMMatrixReadOnly(s.transform).is2D) return {...base,status:'unsupported'};
        }
        const rect = node.getBoundingClientRect();
        const bounds = {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
        if (!finite([...Object.values(bounds),rect.right,rect.bottom])) return {...base,status:'unavailable'};
        if (query.kind === 'dom_rect') return {...base,status:'ok',bounds,screenPoints:[point('top_left',rect.left,rect.top),point('top_right',rect.right,rect.top),point('bottom_right',rect.right,rect.bottom),point('bottom_left',rect.left,rect.bottom)]};
        if (!(node instanceof SVGGraphicsElement)) return {...base,status:'unsupported'};
        const m = node.getScreenCTM();
        // Chrome exposes getScreenCTM as the inherently 2D SVGMatrix, without is2D.
        if (!m || m.is2D === false || !finite([m.a,m.b,m.c,m.d,m.e,m.f])) return {...base,status:'unavailable'};
        let localPoints;
        if (node instanceof SVGLineElement) localPoints=[point('start',node.x1.animVal.value,node.y1.animVal.value),point('end',node.x2.animVal.value,node.y2.animVal.value)];
        else if (node instanceof SVGCircleElement || node instanceof SVGEllipseElement) {
          // Native unstroked local bounds resolve CSS/percentage geometry; animVal can still expose overridden attributes.
          const box=node.getBBox();
          const rx=box.width/2,ry=box.height/2,x=box.x+rx,y=box.y+ry;
          if (!finite([x,y,rx,ry]) || rx<=0 || ry<=0) return {...base,status:'unavailable'};
          localPoints=[point('center',x,y),point('x_radius',x+rx,y),point('y_radius',x,y+ry)];
        } else if (node instanceof SVGPathElement) {
          const length=node.getTotalLength();
          if (!finite([length])) return {...base,status:'unavailable'};
          const start=node.getPointAtLength(0),end=node.getPointAtLength(length);
          localPoints=[point('start',start.x,start.y),point('end',end.x,end.y)];
        } else return {...base,status:'unsupported'};
        const matrix={a:m.a,b:m.b,c:m.c,d:m.d,e:m.e,f:m.f};
        const screenPoints=localPoints.map(p => point(p.name,m.a*p.x+m.c*p.y+m.e,m.b*p.x+m.d*p.y+m.f));
        if (!finite([...localPoints,...screenPoints].flatMap(p=>[p.x,p.y]))) return {...base,status:'unavailable'};
        return {...base,status:'ok',bounds,localPoints,screenPoints,matrix};
      } catch { return {...base,status:'unavailable'}; }
    });
    return {schemaVersion:1,coordinateDomain:'viewport_css_pixels',startedAtMs,finishedAtMs:performance.now()-${originMs},observations};
  })()`;
}
