/**
 * Applies one sample's hourly increments or budget replacements to history.
 *
 * The store retains previous states as its diff base. Copy a changed dictionary
 * once and never edit its predecessor; an unchanged family keeps its identity.
 * Only the touched hours are enumerated, without history-sized entry arrays or
 * Maps. A changed flat dictionary still needs a shallow copy of its own keys.
 */
export function addToHourlyBuckets(
  previous: Record<string, number> | undefined,
  increments: ReadonlyMap<string, number>,
): Record<string, number> {
  let next = previous ?? {};
  for (const [hour, increment] of increments) {
    const value = (previous?.[hour] || 0) + increment;
    if (previous?.[hour] === value) continue;
    // eslint-disable-next-line no-restricted-syntax -- Copy once on the first change, never on later iterations.
    if (next === previous) next = { ...previous };
    next[hour] = value;
  }
  return next;
}

export function updateHourlyBuckets(
  previous: Record<string, number> | undefined,
  replacements: ReadonlyMap<string, number>,
): Record<string, number> {
  let next = previous ?? {};
  for (const [hour, value] of replacements) {
    if (previous?.[hour] === value) continue;
    // eslint-disable-next-line no-restricted-syntax -- Copy once on the first change, never on later iterations.
    if (next === previous) next = { ...previous };
    next[hour] = value;
  }
  return next;
}
