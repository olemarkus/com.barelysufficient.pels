/**
 * Typed parsers for the Homey flow-card argument boundary.
 *
 * Homey passes flow-card argument payloads as untyped objects: scalars,
 * autocomplete `{ id, name }` records, or raw strings. These helpers
 * normalize those payloads to strongly-typed values at the boundary so call
 * sites never branch on `unknown` / `Record<string, unknown>` shapes.
 *
 * Every helper accepts `unknown` (the raw Homey payload) and returns either
 * a concrete typed value or a sentinel (`undefined` / `null`) indicating
 * "not present". Helpers do not throw — callers are responsible for
 * surfacing semantic errors with appropriate flow-card messages.
 */
import { getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';

export type FlowAutocompleteOption = { id?: unknown; name?: unknown };

/**
 * Read a string argument from a flow payload. Accepts plain strings and
 * autocomplete `{ id, name }` records, returning the trimmed `id`. Returns
 * `''` when the key is absent or the value is not a usable string.
 */
export function readFlowStringArg(args: unknown, key: string): string {
  const value = readPayloadProperty(args, key);
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as FlowAutocompleteOption).id;
    if (typeof id === 'string') return id.trim();
  }
  return '';
}

/**
 * Read a finite numeric argument from a flow payload. Returns `null` when
 * the key is absent or cannot be coerced to a finite number.
 */
export function readFlowNumberArg(args: unknown, key: string): number | null {
  const value = readPayloadProperty(args, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Read a device argument from a flow payload, returning the trimmed device id.
 * Handles plain strings, autocomplete `{ id, name }` records, and Homey's
 * legacy `{ data: { id } }` shape via `getDeviceIdFromFlowArg`.
 */
export function readFlowDeviceArg(args: unknown, key = 'device'): string {
  const value = readPayloadProperty(args, key);
  if (value === undefined || value === null) return '';
  return getDeviceIdFromFlowArg(value as RawFlowDeviceArg);
}

/**
 * Read a raw payload value from a flow argument object. Returns `undefined`
 * when the input is not a plain object or the key is missing.
 */
export function readFlowRawArg(args: unknown, key: string): unknown {
  return readPayloadProperty(args, key);
}

function readPayloadProperty(args: unknown, key: string): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
