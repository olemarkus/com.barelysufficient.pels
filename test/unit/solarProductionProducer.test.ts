import { describe, it, expect, vi } from 'vitest';
import { SolarProductionProducer } from '../../lib/device/solarProductionProducer';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const solar = (
  id: string,
  caps: { measure_power?: number | null },
): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'solarpanel',
  capabilitiesObj: {
    ...(caps.measure_power !== undefined ? { measure_power: { value: caps.measure_power } } : {}),
  } as HomeyDeviceLike['capabilitiesObj'],
});

const nonSolar = (id: string): HomeyDeviceLike => ({
  id,
  name: id,
  class: 'socket',
  capabilitiesObj: { measure_power: { value: 500 } } as HomeyDeviceLike['capabilitiesObj'],
});

describe('SolarProductionProducer', () => {
  describe('emits a typed production number on a successful solar read', () => {
    it('emits solar_production_observed with a concrete number when a solar device is present', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([solar('s1', { measure_power: 3000 })], { fullRefresh: true });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({
        component: 'devices',
        event: 'solar_production_observed',
        productionW: 3000,
        solarDeviceCount: 1,
      });
    });

    it('sums production across multiple solar devices', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([
        solar('s1', { measure_power: 3000 }),
        solar('s2', { measure_power: 1200 }),
      ], { fullRefresh: true });
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ productionW: 4200, solarDeviceCount: 2 }));
    });

    it('emits 0 for a present, available, non-producing solar device (real 0, not absent)', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([solar('s1', { measure_power: 0 })], { fullRefresh: true });
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ productionW: 0 }));
    });
  });

  describe('drops (emits nothing) when there is no concrete reading', () => {
    it('emits nothing when a successful fetch contains no solar device', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([nonSolar('ev')], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the device list is empty', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the only solar device is OFFLINE (retained stale caps must not surface)', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      const offline: HomeyDeviceLike = {
        id: 's1', name: 's1', class: 'solarpanel', available: false,
        capabilitiesObj: { measure_power: { value: 3000 } } as HomeyDeviceLike['capabilitiesObj'],
      };
      producer.observe([offline], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits nothing when a present solar device has an unreadable power cap (no null field crosses out)', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([solar('s1', { measure_power: null })], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('does NOT emit a fabricated "cleared" event when a present solar device is later removed', () => {
      const emit = vi.fn();
      const producer = new SolarProductionProducer(emit);
      producer.observe([solar('s1', { measure_power: 3000 })], { fullRefresh: true });
      emit.mockClear();
      producer.observe([nonSolar('ev')], { fullRefresh: true });
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('solar-id membership set (the role-membership the managed/controllable resolution consults)', () => {
    const noopEmit = (): void => undefined;

    it('marks a detected solar id on a non-empty full refresh', () => {
      const producer = new SolarProductionProducer(noopEmit);
      producer.observe([solar('s1', { measure_power: 100 })], { fullRefresh: true });
      expect(producer.isSolarDevice('s1')).toBe(true);
      expect(producer.isSolarDevice('ev')).toBe(false);
    });

    it('re-derives (prunes) the membership set on the next non-empty full refresh', () => {
      const producer = new SolarProductionProducer(noopEmit);
      producer.observe([
        solar('s1', { measure_power: 100 }),
        solar('s2', { measure_power: 200 }),
      ], { fullRefresh: true });
      expect(producer.isSolarDevice('s2')).toBe(true);
      producer.observe([solar('s1', { measure_power: 110 })], { fullRefresh: true });
      expect(producer.isSolarDevice('s1')).toBe(true);
      expect(producer.isSolarDevice('s2')).toBe(false);
    });

    it('a TARGETED refresh never grows the membership set', () => {
      const producer = new SolarProductionProducer(noopEmit);
      producer.observe([solar('s1', { measure_power: 100 })], { fullRefresh: false });
      expect(producer.isSolarDevice('s1')).toBe(false);
    });

    it('an EMPTY full read leaves the membership set intact (benign — re-read next full refresh)', () => {
      const producer = new SolarProductionProducer(noopEmit);
      producer.observe([solar('s1', { measure_power: 100 })], { fullRefresh: true });
      producer.observe([], { fullRefresh: true });
      expect(producer.isSolarDevice('s1')).toBe(true);
    });

    it('keeps an OFFLINE solar device in the membership set so it stays managed', () => {
      const producer = new SolarProductionProducer(noopEmit);
      const offline: HomeyDeviceLike = {
        id: 's1', name: 's1', class: 'solarpanel', available: false,
        capabilitiesObj: { measure_power: { value: 3000 } } as HomeyDeviceLike['capabilitiesObj'],
      };
      producer.observe([offline], { fullRefresh: true });
      expect(producer.isSolarDevice('s1')).toBe(true);
    });

    it('noteSolarDevice additively records a present solar device (realtime path) but ignores non-solar', () => {
      const producer = new SolarProductionProducer(noopEmit);
      producer.noteSolarDevice(solar('s1', { measure_power: 100 }));
      producer.noteSolarDevice(nonSolar('ev'));
      expect(producer.isSolarDevice('s1')).toBe(true);
      expect(producer.isSolarDevice('ev')).toBe(false);
    });
  });
});
