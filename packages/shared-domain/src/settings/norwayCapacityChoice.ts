/** The explicit monthly capacity action sent by the browser to the power owner. */
export const NORWAY_CAPACITY_CHOICE_REQUEST = 'norway_capacity_choice_request';
export type { NorwayCapacityChoiceOffer } from '../../../contracts/src/norwayMonthlyCapacity';
import type { NorwayCapacityChoiceOffer } from '../../../contracts/src/norwayMonthlyCapacity';
export type NorwayCapacityChoiceRequest =
  | { id: string; action: 'cancel' }
  | { id: string; action: 'apply'; offer: NorwayCapacityChoiceOffer };

export function readNorwayCapacityChoiceRequest(raw: unknown): NorwayCapacityChoiceRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 100) return null;
  if (value.action === 'cancel') return { id: value.id, action: 'cancel' };
  if (value.action !== 'apply') return null;
  const offer = readOffer(value.offer);
  return offer ? { id: value.id, action: 'apply', offer } : null;
}

function readOffer(raw: unknown): NorwayCapacityChoiceOffer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const offer = raw as Record<string, unknown>;
  if (typeof offer.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(offer.monthKey)
    || typeof offer.tariffIdentity !== 'string' || typeof offer.revision !== 'string'
    || typeof offer.limitKw !== 'number' || !Number.isFinite(offer.limitKw) || offer.limitKw <= 0) return null;
  return {
    monthKey: offer.monthKey, tariffIdentity: offer.tariffIdentity, revision: offer.revision, limitKw: offer.limitKw,
  };
}
