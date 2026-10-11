import { Type, type Static } from '@sinclair/typebox';

const Selector = Type.String({ minLength: 1, maxLength: 512 });
const ObjectOptions = { additionalProperties: false } as const;
export const RenderBrowserActionsSchema = Type.Array(Type.Union([
  Type.Object({ kind: Type.Literal('click'), selector: Selector }, ObjectOptions),
  Type.Object({ kind: Type.Literal('fill'), selector: Selector, text: Type.String({ maxLength: 4000 }) }, ObjectOptions),
  Type.Object({ kind: Type.Literal('key'), key: Type.Union(['Enter', 'Space', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace'].map(key => Type.Literal(key))) }, ObjectOptions),
  Type.Object({ kind: Type.Literal('scroll'), x: Type.Integer({ minimum: -10000, maximum: 10000 }), y: Type.Integer({ minimum: -10000, maximum: 10000 }) }, ObjectOptions),
  Type.Object({ kind: Type.Literal('wait'), ms: Type.Integer({ minimum: 0, maximum: 10000 }) }, ObjectOptions),
  Type.Object({ kind: Type.Literal('inspect'), selector: Selector }, ObjectOptions),
]), { minItems: 1, maxItems: 32 });
export const RenderBrowserMediaSchema = Type.Object({
  reducedMotion: Type.Optional(Type.Union([Type.Literal('reduce'), Type.Literal('no-preference')])),
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
}, ObjectOptions);
export const RenderBrowserObservationSchema = Type.Object({
  actionIndex: Type.Integer({ minimum: 0, maximum: 31 }),
  matched: Type.Integer({ minimum: 0 }),
  text: Type.String({ maxLength: 2000 }),
  tag: Type.String({ maxLength: 128 }),
  value: Type.String({ maxLength: 2000 }),
  visible: Type.Boolean(),
  disabled: Type.Boolean(),
  checked: Type.Boolean(),
  expanded: Type.Union([Type.Null(), Type.String({ maxLength: 100 })]),
  rect: Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() }, ObjectOptions),
}, ObjectOptions);
export const RenderBrowserObservationsSchema = Type.Array(RenderBrowserObservationSchema, { maxItems: 32 });
export type RenderBrowserAction = Static<typeof RenderBrowserActionsSchema>[number];
export type RenderBrowserMedia = Static<typeof RenderBrowserMediaSchema>;
export type RenderBrowserObservation = Static<typeof RenderBrowserObservationSchema>;
