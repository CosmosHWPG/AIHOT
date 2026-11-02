// One service's editable budget. Disabling enforcement keeps its limits available for re-enabling;
// usage counters and other services are never included in an update request.
export interface BudgetInput {
  enabled?: boolean;
  updated_at?: string;
  per_minute: number;
  per_hour: number;
  per_day: number;
}

export interface BudgetDraft {
  enabled: boolean;
  perMinute: number;
  perHour: number;
  perDay: number;
}

export interface BudgetUpdate {
  enabled?: boolean;
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  reason: string;
  version?: string;
}

export function budgetDraft(budget: BudgetInput): BudgetDraft {
  return { enabled: budget.enabled !== false, perMinute: budget.per_minute, perHour: budget.per_hour, perDay: budget.per_day };
}

export function budgetChanged(budget: BudgetInput, draft: BudgetDraft): boolean {
  const before = budgetDraft(budget);
  return draft.enabled !== before.enabled || draft.perMinute !== before.perMinute
    || draft.perHour !== before.perHour || draft.perDay !== before.perDay;
}

/** Send only edited fields: a switch must not overwrite limits restored by another operation. */
export function budgetUpdate(budget: BudgetInput, draft: BudgetDraft, reason: string): BudgetUpdate | null {
  if (!budgetChanged(budget, draft) || !reason.trim()
    || ![draft.perMinute, draft.perHour, draft.perDay].every(value => Number.isInteger(value) && value >= 0)) return null;
  const before = budgetDraft(budget);
  const update: BudgetUpdate = { reason: reason.trim() };
  if (draft.enabled !== before.enabled) update.enabled = draft.enabled;
  for (const key of ["perMinute", "perHour", "perDay"] as const) if (draft[key] !== before[key]) update[key] = draft[key];
  if (budget.updated_at) update.version = budget.updated_at;
  return update;
}
