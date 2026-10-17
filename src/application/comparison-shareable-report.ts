import type { AgentLocale } from '../agents/language.js';
import type { ComparisonReportFacts } from '../agents/comparison-contract.js';
import type { MetricSideProjection } from './comparison-report-shell.js';
import { actualModelName } from './actual-model-name.js';
import { reportString } from './comparison-report-strings.js';

type Metric = { text: string; missing: boolean };
type Metrics = { baseline?: MetricSideProjection; candidate?: MetricSideProjection };
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const rounded = (n: number) => Number(n.toFixed(2)).toString();

export function shareableMetricTexts(metrics: Metrics, costs: readonly Metric[], locale: AgentLocale): Metric[] {
  const value = (n: number | undefined, format: (n: number) => string): Metric => n === undefined
    ? { text: reportString(locale, 'missing'), missing: true } : { text: format(n), missing: false };
  const time = (ms: number) => {
    const seconds = Math.round(ms / 1000);
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
  };
  const tokens = (n: number) => n >= 1_000_000 ? `${rounded(n / 1_000_000)}M` : n >= 1000 ? `${rounded(n / 1000)}k` : String(n);
  return [value(metrics.baseline?.elapsedMs, time), value(metrics.candidate?.elapsedMs, time),
    value(metrics.baseline?.tokens?.total, tokens), value(metrics.candidate?.tokens?.total, tokens),
    ...costs.map(cost => cost.missing ? cost : { ...cost, text: `$${cost.text}` })];
}

export function renderShareableReport(input: {
  category: string; headline: string; boundary: string; comparisonBody: string; facts: ComparisonReportFacts;
  metrics: Metrics; labels: { baseline: string; candidate: string }; locale: AgentLocale; cost: readonly Metric[];
}): string {
  const { locale, facts } = input;
  const zh = locale === 'zh';
  const t = (en: string, cn: string) => escape(zh ? cn : en);
  const values = shareableMetricTexts(input.metrics, input.cost, locale);
  const side = (key: 'baseline' | 'candidate') => `<span data-model-side="${key}">${escape(reportString(locale, key === 'baseline' ? 'sessionHistorical' : 'sessionCurrent'))} <strong>${escape(input.labels[key])}</strong></span>`;
  const rows = [t('Time', '耗时'), 'Tokens', t('Cost', '费用')].map((label, i) => `<tr><th scope="row">${label}</th><td>${escape(values[i * 2]!.text)}</td><td>${escape(values[i * 2 + 1]!.text)}</td></tr>`).join('');
  const fingerprint = JSON.stringify({ b: sideFingerprint(input.metrics.baseline), c: sideFingerprint(input.metrics.candidate) });
  const timing = facts.metrics?.timingComparable === true ? '' : t('Timing is not comparable. ', '耗时口径未确认可比。');
  const partial = [input.metrics.baseline, input.metrics.candidate].some(side => side?.timing?.coverage.status === 'partial') ? t('Timing coverage is incomplete. ', '耗时记录不完整。') : '';
  return `<!DOCTYPE html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.category)}</title><style data-host-zone="style" data-id="host-style">${CSS}</style></head><body>
<main class="page" data-report-format="4"><article class="share">
<header data-host-zone="header" data-id="host-header"><h1 data-agent-slot="category">${escape(input.category)}</h1><div class="sessions" data-host="session-labels">${side('baseline')}<span aria-hidden="true">→</span>${side('candidate')}</div>${facts.replay.baselineIsSubstitute ? `<p class="notice" data-host="substitute-baseline">${escape(reportString(locale, 'substituteBaselineNote'))}</p>` : ''}</header>
<section class="verdict"><p class="field-label">${escape(reportString(locale, 'shareConclusion'))}</p><h2 data-agent-slot="headline">${input.headline}</h2><p class="boundary" data-agent-slot="boundary">${escape(input.boundary)}</p></section>
<section class="comparison" data-agent-zone="comparison" data-id="agent-comparison">${input.comparisonBody}</section>
<section class="metrics" data-host-zone="metrics" data-id="host-metrics" data-host="metrics" data-metrics-layout="shareable" data-fingerprint="${escape(fingerprint)}"><table><thead><tr><th scope="col">${escape(reportString(locale, 'runtimeMetrics'))}</th><th scope="col">${escape(reportString(locale, 'sessionHistorical'))}</th><th scope="col">${escape(reportString(locale, 'sessionCurrent'))}</th></tr></thead><tbody>${rows}</tbody></table></section>
<footer data-host-zone="cost-note" data-id="host-cost-note"><p>${timing}${partial}${t('Tokens include cache; costs estimated, tools excluded.', 'Token 含缓存；费用为估算，不含工具费用。')}</p><p>${escape(reportString(locale, 'analysisModel'))} · ${escape(actualModelName(facts.models.comparison) ?? reportString(locale, 'missing'))}</p></footer>
</article></main></body></html>`;
}

export function sideFingerprint(side: MetricSideProjection | undefined): (string | number | null)[] {
  return [side?.elapsedMs ?? null, side?.tokens?.total ?? null, side?.costUsd ?? null, side?.pricingStatus ?? null,
    side?.tokens?.input ?? null, side?.tokens?.output ?? null, side?.tokens?.cached ?? null, side?.tokens?.reasoning ?? null];
}

const CSS = `
:root{color-scheme:light;--bg:#f5f6f4;--ink:#24332e;--muted:#758079;--line:#e5e9e4;--accent:#326953}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.75 "Segoe UI","Microsoft YaHei",sans-serif}
.page{max-width:864px;margin:auto;padding:38px 32px 28px}.share{min-width:0;overflow-wrap:anywhere}h1{font-size:24px;line-height:1.4;margin:0 0 8px;font-weight:650}
.sessions{display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:12px}.sessions strong{font-weight:500;color:#526159}
.verdict{position:relative;margin:25px 0 28px;padding:19px 24px;background:linear-gradient(112deg,#eaf2eb,#f5f6f0);border:1px solid #dce7dc;border-radius:12px}
.verdict:before{content:"";position:absolute;left:0;top:19px;bottom:19px;width:3px;background:var(--accent);border-radius:0 3px 3px 0}.field-label{margin:0 0 7px;font-size:11px;font-weight:650;color:var(--accent)}
.verdict h2{font-size:19px;line-height:1.65;margin:0;font-weight:650}.boundary{font-size:12px;color:#647469;margin:8px 0 0}.boundary:empty{display:none}
.comparison{line-height:1.9}.comparison p{margin:0 0 12px}.comparison h2,.comparison h3{font-size:15px;margin:16px 0 8px}.comparison>:first-child{margin-top:0}.comparison figure{margin:14px 0;min-width:0}.comparison img{display:block;width:100%;height:auto;object-fit:contain}.comparison figcaption,.notice{font-size:12px;color:var(--muted)}
[data-component="page-row"],[data-component="media-grid"],[data-component="media-compare"],[data-component="split-compare"]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:8px 10px;border-bottom:1px solid var(--line);font-weight:400}thead{color:var(--muted);font-size:11px}.metrics{border-top:1px solid var(--line);margin-top:26px;padding-top:12px}.metrics table{table-layout:fixed;font-size:13px}.metrics td{font-variant-numeric:tabular-nums}.metrics th:first-child{width:40%}
footer{margin-top:17px;font-size:11px;color:var(--muted)}footer p{margin:4px 0}a{color:var(--accent);text-underline-offset:3px}a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:600px){.page{padding:26px 20px}h1{font-size:21px}.verdict{padding:18px 19px}.verdict h2{font-size:18px}.comparison table{font-size:12px}[data-component="page-row"],[data-component="media-grid"],[data-component="media-compare"],[data-component="split-compare"]{grid-template-columns:1fr}}
`;
