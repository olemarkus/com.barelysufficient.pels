import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { PlanDeviceSnapshot } from '../src/ui/planTypes.ts';
import {
  buildHomeBatteryStatus,
  buildSettingsUiPlanHomeBattery,
  type HomeBatteryCard,
} from '../../../lib/plan/batteryStatusReadModel.ts';
import type { StorageHold } from '../../../lib/plan/planTypes.ts';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';
// A home battery's Overview card: the state word and its power on one row,
// then the charge level, then why PELS holds it. Vocabulary source:
// notes/ui-terminology.md § Home battery vocabulary.

vi.mock('../src/ui/homey.ts', () => ({ callApi: vi.fn(), invalidateApiCache: vi.fn() }));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/planRedesign.ts', () => ({ bumpPlanSurface: vi.fn() }));

const { PlanGenericCard } = await import('../src/ui/views/PlanDeviceCards.tsx');

const battery = (signedW: number, percent: number): HomeBatteryCard => ({
  kind: 'battery',
  control: 'drivable',
  power: { kind: 'observed', signedW },
  level: { kind: 'observed', percent },
});

const batteryDevice = (card: HomeBatteryCard, hold: StorageHold, exporting = false): PlanDeviceSnapshot => ({
  ...uiDeviceFixture({ id: 'battery-1', name: 'Sessy battery', controllable: false }),
  status: buildHomeBatteryStatus(card, hold, true, false, { exporting }),
  homeBattery: buildSettingsUiPlanHomeBattery(card, hold, true, { exporting }),
});

const renderCard = (dev: PlanDeviceSnapshot): HTMLDivElement => {
  const mount = document.createElement('div');
  act(() => {
    render(h(PlanGenericCard, { dev, dryRun: false, nowMs: 1_000, evStateLine: null }), mount);
  });
  return mount;
};

describe('home battery Overview card', () => {
  it('shows the state and power, then the charge level, then the reason', () => {
    const card = renderCard(batteryDevice(battery(-2400, 64), { kind: 'relief' }));
    const lines = [...card.querySelectorAll('.plan-card__state-row > span, .plan-card__secondary-line, p')].map((el) => el.textContent);
    expect(lines).toEqual([
      'Supplying',
      '2.4 kW',
      '64 % charged',
      'Holding your limit so your devices keep running',
    ]);
  });

  it('shows a capped charge as Limited · Charging, with the charge it waits for', () => {
    const card = renderCard(batteryDevice(battery(600, 52), { kind: 'charge_limit', heldBackKw: 2.4 }));
    const lines = [...card.querySelectorAll('.plan-card__state-row > span, .plan-card__secondary-line, p')].map((el) => el.textContent);
    expect(lines).toEqual([
      'Limited · Charging',
      '0.6 kW',
      '52 % charged',
      'Waiting to charge faster · 2.4 kW more needed',
    ]);
  });

  it('names a sale Selling to grid only while the battery discharges and the meter exports', () => {
    const selling = renderCard(batteryDevice(battery(-2400, 64), { kind: 'plan_export' }, true));
    const lines = [...selling.querySelectorAll('.plan-card__state-row > span, .plan-card__secondary-line, p')].map((el) => el.textContent);
    expect(lines).toEqual([
      'Selling to grid',
      '2.4 kW',
      '64 % charged',
      'Selling stored energy while export pays more',
    ]);
    // The house still takes all of it: no export at the meter, so it is supplying.
    expect(renderCard(batteryDevice(battery(-2400, 64), { kind: 'plan_export' }, false))
      .querySelector('.plan-card__state-row > span')?.textContent).toBe('Supplying');
    // Solar export alone, beside a battery that is not discharging, is no sale.
    expect(renderCard(batteryDevice(battery(0, 64), { kind: 'plan_export' }, true))
      .querySelector('.plan-card__state-row > span')?.textContent).toBe('Supplying');
    // A household-supply hold never reads as selling, whatever the meter shows.
    expect(renderCard(batteryDevice(battery(-2400, 64), { kind: 'plan_supply' }, true))
      .querySelector('.plan-card__state-row > span')?.textContent).toBe('Supplying');
  });

  it('adds what a battery in its own mode is doing to the charge level', () => {
    const card = renderCard(batteryDevice(battery(900, 71), { kind: 'none' }));
    expect(card.querySelector('.plan-card__secondary-line')?.textContent).toBe('71 % charged · charging');
  });

  it('shows no fact line on a load card with no facts', () => {
    const card = renderCard(uiDeviceFixture({ id: 'pump-1', name: 'Pool Pump', currentState: 'on', plannedState: 'keep' }));
    expect(card.querySelector('.plan-card__secondary-line')).toBeNull();
  });
});
