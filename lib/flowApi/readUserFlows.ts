/*
 * Defensive reader for the Homey user-flow lists.
 *
 * Fail-closed contract (see notes/native-wiring/): the result is a typed
 * three-state. A consumer must be able to tell "read OK, no conflicting
 * writes found" apart from "could not read" — otherwise a later auto-enable
 * step could flip native wiring on during a transient Web API failure, the
 * exact bug this contract exists to prevent.
 *
 *   { status: 'ok', writes }        → both endpoints returned a flow map.
 *                                     `writes` may be empty (genuinely none).
 *   { status: 'unknown', reason }   → a read threw, returned a non-object,
 *                                     or otherwise could not be trusted.
 *
 * If EITHER endpoint cannot be read we return 'unknown': we cannot prove the
 * absence of a conflicting flow in an endpoint we never saw.
 *
 * The HTTP capability is injected (`get`) so this module stays pure and free
 * of any cross-layer dependency on the device transport's REST client. The
 * `get` contract: resolve the JSON body for a Homey Web API path (no `/api/`
 * prefix), reject on non-2xx or transport error.
 */
import { normalizeError } from '../utils/errorUtils';
import { normalizeFlowCapabilityWrites, type FlowCapabilityWrites } from './userFlows';

export const FLOW_API_PATH = 'manager/flow/flow/';
export const ADVANCED_FLOW_API_PATH = 'manager/flow/advancedflow/';

export type FlowReadResult =
  | { status: 'ok'; writes: FlowCapabilityWrites }
  | { status: 'unknown'; reason: string };

export type FlowApiGet = (path: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readEndpoint(
  get: FlowApiGet,
  path: string,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }> {
  let raw: unknown;
  try {
    raw = await get(path);
  } catch (error) {
    return { ok: false, reason: `read ${path} failed: ${normalizeError(error).message}` };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: `read ${path} returned a non-object response` };
  }
  return { ok: true, value: raw };
}

/**
 * Read both flow endpoints and resolve the device-capability write map.
 * Fails closed: any unreadable / untrusted endpoint yields `status: 'unknown'`.
 */
export async function readFlowCapabilityWrites(deps: { get: FlowApiGet }): Promise<FlowReadResult> {
  // The two endpoint reads are independent; run them concurrently.
  // `readEndpoint` never rejects (it captures failures as `{ ok: false }`),
  // so the fail-closed precedence is applied after both settle.
  const [flat, advanced] = await Promise.all([
    readEndpoint(deps.get, FLOW_API_PATH),
    readEndpoint(deps.get, ADVANCED_FLOW_API_PATH),
  ]);

  if (!flat.ok) return { status: 'unknown', reason: flat.reason };
  if (!advanced.ok) return { status: 'unknown', reason: advanced.reason };

  return {
    status: 'ok',
    writes: normalizeFlowCapabilityWrites(flat.value, advanced.value),
  };
}
