import type { EvCarAssociations } from '../../packages/contracts/src/types';

/**
 * Runtime copy of `packages/contracts/src/evCarAssociations.ts`. Kept duplicated
 * on purpose: runtime code may not take a value dependency on the contracts
 * package (`no-runtime-value-deps-on-contracts`), and the settings UI may not
 * import `lib/**`. Change both together — `test/unit/evCarAssociations.test.ts`
 * asserts they agree.
 */
export const normalizeEvCarAssociations = (value: unknown): EvCarAssociations => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([chargerId, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const rawCarIds = (entry as Record<string, unknown>).carIds;
      if (!Array.isArray(rawCarIds)) return [];
      const carIds = [...new Set(
        rawCarIds.filter((carId): carId is string => typeof carId === 'string' && carId.length > 0),
      )];
      // An empty eligibility set is indistinguishable from "off", so it is not
      // stored — otherwise a charger the user un-ticked every car on would keep
      // an entry that reads as configured everywhere downstream.
      if (carIds.length === 0) return [];
      return [[chargerId, { carIds }]];
    }),
  );
};
