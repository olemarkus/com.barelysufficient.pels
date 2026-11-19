import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { NorwayCapacityTariffRead } from '../../packages/contracts/src/norwayCapacityTariff';
import type { NorwayMonthlyCapacityRead } from '../../packages/contracts/src/norwayMonthlyCapacity';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import { NORWAY_CAPACITY_CHOICE_REQUEST } from '../../packages/shared-domain/src/settings/norwayCapacityChoice';
import type { PowerTrackerState } from './trackerTypes';
import { projectNorwayMonthHistory, norwayMonthKey, NORWAY_BILLING_ZONE } from './norwayMonthlyCapacityHistory';
import { resolveNorwayMonthlyCapacity } from './norwayMonthlyCapacity';
import { NorwayCapacityChoice } from './norwayCapacityChoice';

export type NorwayMonthlyCapacityPorts = {
  readTracker(): PowerTrackerState;
  readScalars(): CapacityScalarSettings;
  readTariff(monthKey: string): NorwayCapacityTariffRead;
  readTimeZone(): string;
  requestRebuild(): void;
};

type SettingsEvents = {
  on(event: 'set' | 'unset', listener: (key: string) => void): unknown;
  removeListener(event: 'set' | 'unset', listener: (key: string) => void): unknown;
};

/** Main's monthly tariff accounting and explicit choice actions share one producer. */
export class NorwayMonthlyCapacityOwner {
  constructor(private readonly ports: NorwayMonthlyCapacityPorts, readonly choice: NorwayCapacityChoice) {}

  attach(settings: SettingsEvents): void {
    settings.on('set', this.onSettingChanged);
    settings.on('unset', this.onSettingChanged);
  }

  detach(settings: SettingsEvents): void {
    settings.removeListener('set', this.onSettingChanged);
    settings.removeListener('unset', this.onSettingChanged);
  }

  read(atMs: number): NorwayMonthlyCapacityRead {
    const scalars = this.ports.readScalars();
    if (scalars.periodMinutes !== 60 || !scalars.capacityEnabled) return { state: 'hidden' };
    const tariff = this.ports.readTariff(norwayMonthKey(atMs));
    if (tariff.state === 'unsupported' && tariff.reason === 'non_norway_scheme') return { state: 'hidden' };
    if (this.ports.readTimeZone() !== NORWAY_BILLING_ZONE) return { state: 'unavailable', reason: 'timezone' };
    if (tariff.state !== 'supported') {
      return { state: 'unavailable', reason: tariff.reason === 'no_grid_company' ? 'grid_company' : 'tariff' };
    }
    const tracker = this.ports.readTracker();
    return resolveNorwayMonthlyCapacity(projectNorwayMonthHistory(tracker, atMs),
      tariff.tariff, scalars, this.choice.applyTo(scalars, atMs).limitKw, atMs);
  }

  onSettingChanged = (key: string): void => {
    try { this.handleSettingChanged(key); } catch (error) {
      this.choice.noteFailure();
      getLogger('power/norway-monthly-capacity').error({
        event: 'norway_capacity_choice_failed', err: normalizeError(error),
      });
    }
  };

  private handleSettingChanged(key: string): void {
    this.choice.onSettingChanged(key);
    if (key !== NORWAY_CAPACITY_CHOICE_REQUEST) return;
    const nowMs = Date.now();
    const read = this.read(nowMs);
    const offer = read.state === 'ready' && read.advice.state === 'suggestion' && read.advice.actionable
      ? { monthKey: read.monthKey, tariffIdentity: read.tariffIdentity,
        limitKw: read.advice.limitKw, revision: read.advice.version } : null;
    if (this.choice.processRequest(offer, this.ports.readScalars(), nowMs)) this.ports.requestRebuild();
  }
}
