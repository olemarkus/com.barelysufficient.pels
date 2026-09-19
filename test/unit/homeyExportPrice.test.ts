import { describe, expect, it, vi } from 'vitest';
import {
  EXPORT_FIXED_OPTION_API_PATH,
  EXPORT_TYPE_API_PATH,
  EXPORT_USER_COSTS_API_PATH,
  fetchHomeyExportTerms,
  sumExportCostComponents,
} from '../../lib/price/homeyExportPrice';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';

/** Serves Homey's export routes the way a real hub answers them. */
const serve = (bodies: Record<string, unknown>) => async (path: string) => {
  if (!(path in bodies)) throw new Error(`unexpected path ${path}`);
  const body = bodies[path];
  if (body instanceof Error) throw body;
  return body;
};

describe('sumExportCostComponents', () => {
  it('sums the named components the way Homey does', () => {
    // The shape the test Homey actually returns for a 0.30 NOK/kWh tariff.
    expect(sumExportCostComponents({ costs: { user_fixed_base: { value: 0.3 } } })).toBeCloseTo(0.3, 10);
    expect(sumExportCostComponents({ costs: { a: { value: 0.2 }, b: { value: 0.05 } } })).toBeCloseTo(0.25, 10);
  });

  it('keeps a negative amount, which is a market that charges for export', () => {
    expect(sumExportCostComponents({ costs: { fee: { value: -0.11 } } })).toBeCloseTo(-0.11, 10);
  });

  it('refuses an amount it cannot total exactly', () => {
    // Skipping a component would quietly understate what the owner is paid.
    expect(sumExportCostComponents({ costs: { a: { value: 0.2 }, b: { value: 'x' } } })).toBeNull();
    expect(sumExportCostComponents({ costs: {} })).toBeNull();
    expect(sumExportCostComponents({})).toBeNull();
    expect(sumExportCostComponents(null)).toBeNull();
  });
});

describe('fetchHomeyExportTerms', () => {
  it('reads a fixed feed-in tariff', async () => {
    const terms = await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: 'fixed',
      [EXPORT_FIXED_OPTION_API_PATH]: { value: { costs: { user_fixed_base: { value: 0.3 } } } },
    }));

    expect(terms).toEqual({ kind: 'fixed', amount: 0.3 });
  });

  it('reads a dynamic export formula', async () => {
    const terms = await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: 'dynamic',
      [EXPORT_USER_COSTS_API_PATH]: { mathExpression: '{{ [[importPrice]] - 0.1 }}', type: 'offset_math_expression' },
    }));

    expect(terms).toEqual({ kind: 'formula', expression: '{{ [[importPrice]] - 0.1 }}' });
  });

  it('asks for nothing beyond the type when export is disabled', async () => {
    const webApiGet = vi.fn(async () => 'disabled');

    expect(await fetchHomeyExportTerms(webApiGet)).toEqual({ kind: 'disabled' });
    expect(webApiGet).toHaveBeenCalledTimes(1);
  });

  it('reads firmware without export pricing as paying nothing', async () => {
    const terms = await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: new HomeyHttpStatusError(404, 'Cannot GET'),
    }));

    expect(terms).toEqual({ kind: 'disabled' });
  });

  it('reads a dynamic export with no expression as paying nothing', async () => {
    // Homey applies no raw-spot fallback on the export side either.
    const terms = await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: 'dynamic',
      [EXPORT_USER_COSTS_API_PATH]: null,
    }));

    expect(terms).toEqual({ kind: 'disabled' });
  });

  it('reports a failed read rather than an amount it could not establish', async () => {
    // Each of these would otherwise become "you are paid nothing", which is a
    // claim about the owner's contract that no failed read can support.
    expect(await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: new HomeyHttpStatusError(500, 'boom'),
    }))).toEqual({ kind: 'failed', reasonCode: 'read_threw' });

    expect(await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: 'fixed',
      [EXPORT_FIXED_OPTION_API_PATH]: { value: null },
    }))).toEqual({ kind: 'failed', reasonCode: 'unrecognised_body' });

    expect(await fetchHomeyExportTerms(serve({
      [EXPORT_TYPE_API_PATH]: 'something_new',
    }))).toEqual({ kind: 'failed', reasonCode: 'unrecognised_body' });
  });
});
