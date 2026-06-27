import { describe, it, expect, vi } from 'vitest';
import { BatteryStateProducer } from '../../lib/device/batteryStateProducer';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const battery = (
  id: string,
  caps: { measure_battery?: number | null; measure_power?: number | null },
): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'battery',
  capabilitiesObj: {
    ...(caps.measure_battery !== undefined ? { measure_battery: { value: caps.measure_battery } } : {}),
    ...(caps.measure_power !== undefined ? { measure_power: { value: caps.measure_power } } : {}),
  } as HomeyDeviceLike['capabilitiesObj'],
});

const nonBattery = (id: string): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'socket',
  capabilitiesObj: { measure_power: { value: 500 } } as HomeyDeviceLike['capabilitiesObj'],
});

describe('BatteryStateProducer', () => {
  describe('emits typed numbers on a successful battery read', () => {
    it('emits battery_state_observed with concrete numbers when a battery is present', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([battery('b1', { measure_battery: 62, measure_power: 1200 })], { fullRefresh: true });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({
        component: 'devices',
        event: 'battery_state_observed',
        batterySoc: 62,
        batteryPowerW: 1200,
        batteryDeviceCount: 1,
      });
    });

    it('carries the negative sign of a discharging battery', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([battery('b1', { measure_battery: 40, measure_power: -1500 })], { fullRefresh: true });
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ batterySoc: 40, batteryPowerW: -1500 }));
    });

    it('sums power and means SoC across multiple batteries', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([
        battery('b1', { measure_battery: 60, measure_power: 1000 }),
        battery('b2', { measure_battery: 80, measure_power: -400 }),
      ], { fullRefresh: true });
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        batterySoc: 70, batteryPowerW: 600, batteryDeviceCount: 2,
      }));
    });
  });

  describe('drops (emits nothing) when there is no concrete reading', () => {
    it('emits nothing when a successful fetch contains no battery', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([nonBattery('ev')], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the device list is empty', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the only battery is OFFLINE (retained stale caps must not surface)', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      const offline: HomeyDeviceLike = {
        id: 'b1',
        name: 'b1',
        class: 'battery',
        available: false,
        capabilitiesObj: {
          measure_battery: { value: 62 },
          measure_power: { value: 1200 },
        } as HomeyDeviceLike['capabilitiesObj'],
      };
      producer.observe([offline], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the only battery reports an out-of-range SoC (150)', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([battery('b1', { measure_battery: 150, measure_power: 800 })], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when a present battery has an unreadable power cap (no null field crosses out)', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([battery('b1', { measure_battery: 62, measure_power: null })], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when a present battery has an unreadable SoC cap', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([battery('b1', { measure_battery: null, measure_power: 800 })], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('does NOT emit a fabricated "cleared" event when a present battery is later removed', () => {
      const emit = vi.fn();
      const producer = new BatteryStateProducer(emit);
      producer.observe([battery('b1', { measure_battery: 62, measure_power: 1200 })], { fullRefresh: true });
      emit.mockClear();
      // Battery gone on a later full refresh — nothing observed, so nothing emitted.
      producer.observe([nonBattery('ev')], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('battery-id membership set (the role-membership the managed/controllable resolution consults)', () => {
    const noopEmit = (): void => undefined;

    it('marks a detected battery id as a battery on a non-empty full refresh', () => {
      const producer = new BatteryStateProducer(noopEmit);
      producer.observe([battery('b1', { measure_battery: 60, measure_power: 100 })], { fullRefresh: true });
      expect(producer.isBatteryDevice('b1')).toBe(true);
      expect(producer.isBatteryDevice('ev')).toBe(false);
    });

    it('re-derives (prunes) the membership set on the next non-empty full refresh', () => {
      const producer = new BatteryStateProducer(noopEmit);
      producer.observe([
        battery('b1', { measure_battery: 60, measure_power: 100 }),
        battery('b2', { measure_battery: 70, measure_power: 200 }),
      ], { fullRefresh: true });
      expect(producer.isBatteryDevice('b1')).toBe(true);
      expect(producer.isBatteryDevice('b2')).toBe(true);
      producer.observe([battery('b1', { measure_battery: 61, measure_power: 110 })], { fullRefresh: true });
      expect(producer.isBatteryDevice('b1')).toBe(true);
      expect(producer.isBatteryDevice('b2')).toBe(false);
    });

    it('a TARGETED refresh never grows the membership set', () => {
      const producer = new BatteryStateProducer(noopEmit);
      producer.observe([battery('b1', { measure_battery: 60, measure_power: 100 })], { fullRefresh: false });
      expect(producer.isBatteryDevice('b1')).toBe(false);
    });

    it('an EMPTY full read leaves the membership set intact (benign — re-read next full refresh)', () => {
      const producer = new BatteryStateProducer(noopEmit);
      producer.observe([battery('b1', { measure_battery: 60, measure_power: 100 })], { fullRefresh: true });
      producer.observe([], { fullRefresh: true });
      expect(producer.isBatteryDevice('b1')).toBe(true);
    });

    // An OFFLINE battery keeps its membership (so the managed battery keeps its
    // managed identity and recovers when back online) even though it emits no event.
    it('keeps an OFFLINE battery in the membership set so it stays managed', () => {
      const producer = new BatteryStateProducer(noopEmit);
      const offline: HomeyDeviceLike = {
        id: 'b1',
        name: 'b1',
        class: 'battery',
        available: false,
        capabilitiesObj: {
          measure_battery: { value: 62 }, measure_power: { value: 1200 },
        } as HomeyDeviceLike['capabilitiesObj'],
      };
      producer.observe([offline], { fullRefresh: true });
      expect(producer.isBatteryDevice('b1')).toBe(true);
    });
  });
});
