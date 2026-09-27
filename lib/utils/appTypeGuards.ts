import type { DeviceControlProfiles } from '../../packages/contracts/src/types';
import { normalizeDeviceControlProfiles } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';

/**
 * Returns true when the input is a plain object literal (Object.prototype or
 * a bare null-prototype object). Rejects arrays, class instances, Date, Map,
 * Set, etc. — Homey settings persistence only round-trips plain objects.
 */
export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function isStringMap(value: unknown): value is Record<string, string> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'string');
}

export function isBooleanMap(value: unknown): value is Record<string, boolean> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'boolean');
}

export function isNumberMap(value: unknown): value is Record<string, number> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && isFiniteNumber(entry));
}

export function isDeviceControlProfiles(value: unknown): value is DeviceControlProfiles {
  if (!value || typeof value !== 'object') return false;
  const normalized = normalizeDeviceControlProfiles(value);
  if (!normalized) return false;
  return Object.keys(normalized).length === Object.keys(value).length;
}
