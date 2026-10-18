import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { record } from './json.js';

export const ExecutionBoundarySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  mode: Type.Literal('trusted-local'),
  environment: Type.Object({ source: Type.Literal('host-configured'), rule: Type.String(), names: Type.Array(Type.String()) }, { additionalProperties: false }),
  native: Type.Object({ source: Type.Literal('pack-declared'), permissionMode: Type.String(), confirmation: Type.Literal('unknown') }, { additionalProperties: false }),
  hostShell: Type.Object({ source: Type.Literal('host-configured'), rule: Type.String(), filesystem: Type.Literal('unrestricted'), network: Type.Literal('unrestricted') }, { additionalProperties: false }),
  filesystem: Type.Literal('unknown'),
  network: Type.Literal('unknown'),
  extensions: Type.Literal('unknown'),
  invocation: Type.Union([Type.Literal('pack-default'), Type.Literal('explicit-argv-override')]),
  controls: Type.Array(Type.String()),
  limitations: Type.Array(Type.String()),
}, { additionalProperties: false });
export type ExecutionBoundary = Static<typeof ExecutionBoundarySchema>;
export const NativeExecutionObservationSchema = Type.Object({
  source: Type.Literal('runtime-native'),
  permissionMode: Type.Union(['read-only', 'workspace-write', 'danger-full-access', 'external-sandbox', 'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].map(value => Type.Literal(value))),
  matchesConfigured: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type NativeExecutionObservation = Static<typeof NativeExecutionObservationSchema>;

export function nativeExecutionObservations(events: readonly { type: string; payload: unknown }[]): NativeExecutionObservation[] {
  return events.flatMap(event => {
    const observation = record(event.payload).executionObservation;
    return event.type === 'runtime.session_started' && Value.Check(NativeExecutionObservationSchema, observation) ? [observation] : [];
  });
}

export function nativeExecutionObservation(value: unknown, configured: string) {
  if (typeof value !== 'string' || !['read-only', 'workspace-write', 'danger-full-access', 'external-sandbox', 'default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(value)) return undefined;
  return { source: 'runtime-native' as const, permissionMode: value, ...(configured === 'unknown' ? {} : { matchesConfigured: value === configured }) };
}

export function executionBoundaryText(boundary?: ExecutionBoundary, locale: 'zh' | 'en' = 'zh'): string {
  if (!boundary) return locale === 'en' ? 'Execution boundary: not recorded / not declared (unknown).' : '执行边界：未记录 / 未声明（unknown）。';
  if (locale === 'en') return `Trusted local execution; Candidate environment selected by ${boundary.environment.rule} (Host configured). Native permissions: ${boundary.native.permissionMode} (Pack declared; native confirmation unknown at launch, later observations in events). Host shell: ${boundary.hostShell.rule}. No Reprise OS filesystem or network isolation; extension loading unknown.`;
  return `执行方式：可信本地；Candidate 环境按 ${boundary.environment.rule} 收敛（Host 配置）。原生权限：${boundary.native.permissionMode}（Pack 声明，启动时确认未知，后续确认见原生事件）。Host shell：${boundary.hostShell.rule}。文件与网络无 Reprise 系统隔离；扩展加载未知。`;
}

export function nativeExecutionText(observations: readonly NativeExecutionObservation[] = [], locale: 'zh' | 'en' = 'zh'): string {
  const label = locale === 'zh' ? '后续原生确认' : 'Later native observations';
  if (!observations.length) return `${label}: ${locale === 'zh' ? '未记录' : 'not recorded'}.`;
  return `${label}: ${observations.map(item => `${item.permissionMode} (${item.matchesConfigured === undefined ? 'comparison unknown' : item.matchesConfigured ? 'matches configuration' : 'configuration conflict'})`).join('; ')}.`;
}
