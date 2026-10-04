type Variant = 'original' | 'swapped' | 'blind';
type PlanRow = { caseId: string; repetition: number; variant: Variant };

/** Resolve a paid lane before input verification, model configuration or agent creation. */
export function selectComparisonEvaluationRows<T extends PlanRow>(rows: readonly T[], flags: readonly string[], caseIds: readonly string[]) {
  let selectedCase: string | undefined;
  let repetition: number | undefined;
  let variant: Variant | undefined;
  let maxRows: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]!;
    const value = flags[index + 1];
    if (!value || seen.has(flag)) throw new Error('Unknown, missing or duplicate real option.');
    seen.add(flag);
    if (flag === '--case') {
      if (!caseIds.includes(value)) throw new Error('Unknown selected case.');
      selectedCase = value;
    } else if (flag === '--variant' && ['original', 'swapped', 'blind'].includes(value)) variant = value as Variant;
    else if ((flag === '--repetition' || flag === '--max-rows') && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) {
      if (flag === '--repetition') repetition = Number(value);
      else maxRows = Number(value);
    } else throw new Error('Unknown or invalid real option.');
  }
  const selected = rows.filter(row => (selectedCase === undefined || row.caseId === selectedCase)
    && (repetition === undefined || row.repetition === repetition) && (variant === undefined || row.variant === variant)).slice(0, maxRows);
  if (!selected.length) throw new Error('No selected evaluation cases.');
  const suffix = [selectedCase, repetition === undefined ? undefined : `r${repetition}`, variant].filter(value => value !== undefined).join('-');
  return { rows: selected, ledgerFile: suffix ? `ledger-${suffix}.json` : 'ledger.json' };
}
