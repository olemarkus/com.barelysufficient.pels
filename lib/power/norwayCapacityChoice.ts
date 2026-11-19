import { norwayMonthKey } from './norwayMonthlyCapacityHistory';
import type { NorwayCapacityTariffRead } from '../../packages/contracts/src/norwayCapacityTariff';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import {
  NORWAY_CAPACITY_CHOICE_REQUEST, readNorwayCapacityChoiceRequest,
  type NorwayCapacityChoiceOffer,
} from '../../packages/shared-domain/src/settings/norwayCapacityChoice';

const STATE_KEY = 'norway_capacity_choice_state';
export type {
  NorwayCapacityChoiceState, NorwayCapacityChoiceOutcome,
} from '../../packages/contracts/src/norwayMonthlyCapacity';
import type {
  NorwayCapacityChoiceState, NorwayCapacityChoiceOutcome,
} from '../../packages/contracts/src/norwayMonthlyCapacity';
const isOutcome = (outcome: NorwayCapacityChoiceOutcome): boolean => outcome.state === 'idle'
  || ((outcome.state === 'accepted' || outcome.state === 'rejected')
    && typeof outcome.requestId === 'string' && typeof outcome.message === 'string');

type SavedChoice = {
  choice: NorwayCapacityChoiceState; outcome: NorwayCapacityChoiceOutcome;
  configuration?: Readonly<Record<string, string>>;
  marginKw?: number;
};
const CONFIGURATION_KEYS = [
  'capacity_limit_kw', 'capacity_margin_kw', 'capacity_period_minutes', 'capacity_enabled', 'price_scheme',
  'nettleie_orgnr', 'nettleie_tariffgruppe',
];
const EMPTY: SavedChoice = { choice: { state: 'normal' }, outcome: { state: 'idle' } };
/** Durable explicit owner choice. The normal capacity setting is never overwritten. */
export class NorwayCapacityChoice {
  private saved: SavedChoice = EMPTY;

  private acceptedTariffIdentity = '';

  constructor(
    private readonly settings: SettingsPort,
    private readonly readTariff: (monthKey: string) => NorwayCapacityTariffRead,
  ) {
    let raw: unknown;
    try { raw = settings.get(STATE_KEY); } catch { return; }
    if (typeof raw !== 'object' || raw === null) return;
    const { choice, outcome } = raw as SavedChoice;
    if (!choice || !outcome) return;
    const validOutcome = isOutcome(outcome);
    if (!validOutcome) return;
    if (choice.state === 'normal') this.saved = { choice, outcome };
    else if (choice.state === 'active' && Number.isFinite(choice.normalLimitKw) && choice.normalLimitKw > 0) {
      const request = readNorwayCapacityChoiceRequest({ id: 'restore', action: 'apply', offer: choice.offer });
      if (request?.action === 'apply') {
        this.saved = { choice: { ...choice, offer: request.offer }, outcome,
          configuration: this.readSavedConfiguration(raw),
          ...(typeof (raw as SavedChoice).marginKw === 'number' && Number.isFinite((raw as SavedChoice).marginKw)
            ? { marginKw: (raw as SavedChoice).marginKw } : {}),
        };
        this.acceptedTariffIdentity = request.offer.tariffIdentity;
      }
    }
  }

  private readSavedConfiguration(raw: object): Readonly<Record<string, string>> {
    const configuration: unknown = (raw as SavedChoice).configuration;
    if (typeof configuration === 'object' && configuration !== null
      && Object.values(configuration).every((value) => typeof value === 'string')) {
      return configuration as Readonly<Record<string, string>>;
    }
    try { return this.captureConfiguration(); } catch { return {}; }
  }

  private captureConfiguration(): Readonly<Record<string, string>> {
    return Object.fromEntries(CONFIGURATION_KEYS.map((key) => (
      [key, JSON.stringify(this.settings.get(key)) ?? 'absent']
    )));
  }

  onSettingChanged(key: string): void {
    if (!CONFIGURATION_KEYS.includes(key) || this.saved.choice.state !== 'active') return;
    const raw = this.settings.get(key);
    if (key === 'capacity_limit_kw' && raw === this.saved.choice.normalLimitKw) return;
    if (key === 'capacity_margin_kw' && raw === this.saved.marginKw) return;
    const current = JSON.stringify(raw) ?? 'absent';
    if (current !== this.saved.configuration?.[key]) this.cancel();
  }

  readState(scalars: CapacityScalarSettings, atMs: number): NorwayCapacityChoiceState {
    const { choice } = this.saved;
    if (choice.state !== 'active' || choice.offer.monthKey !== norwayMonthKey(atMs)) return { state: 'normal' };
    return this.readChoice(scalars);
  }

  private readChoice(scalars: CapacityScalarSettings): NorwayCapacityChoiceState {
    const { choice } = this.saved;
    return choice.state === 'active'
      && choice.normalLimitKw === scalars.limitKw && scalars.capacityEnabled && scalars.periodMinutes === 60
      && (this.saved.marginKw === undefined || this.saved.marginKw === scalars.marginKw)
      && this.matchesTariff(choice.offer) ? choice : { state: 'normal' };
  }

  private matchesTariff(offer: NorwayCapacityChoiceOffer): boolean {
    try {
      const read = this.readTariff(offer.monthKey);
      if (read.state === 'supported') {
        this.acceptedTariffIdentity = read.tariff.identity;
        return read.tariff.identity === offer.tariffIdentity;
      }
      if (read.state === 'unsupported'
        || read.reason === 'no_matching_tariff_file' || read.reason === 'no_grid_company') {
        this.acceptedTariffIdentity = '';
        return false;
      }
      return this.acceptedTariffIdentity === offer.tariffIdentity;
    } catch { return false; }
  }

  noteFailure(): void {
    try {
      const request = readNorwayCapacityChoiceRequest(this.settings.get(NORWAY_CAPACITY_CHOICE_REQUEST));
      if (request) this.saved = { ...this.saved, outcome: {
        state: 'rejected', requestId: request.id, message: 'The capacity change could not be saved. Try again.',
      } };
    } catch { /* The request cannot be acknowledged without its identity. */ }
  }

  readOutcome(): NorwayCapacityChoiceOutcome { return this.saved.outcome; }

  /** Normal settings plus the accepted choice, resolved later for each planned period. */
  forPlanning(scalars: CapacityScalarSettings, nowMs: number): CapacityScalarSettings {
    const choice = this.readChoice(scalars);
    return choice.state === 'active' && choice.offer.monthKey <= norwayMonthKey(nowMs) ? {
      ...scalars, monthlyCapacityChoice: { monthKey: choice.offer.monthKey, limitKw: choice.offer.limitKw },
    } : scalars;
  }

  applyTo(scalars: CapacityScalarSettings, atMs: number): CapacityScalarSettings {
    const choice = this.readState(scalars, atMs);
    return choice.state === 'active' ? { ...scalars, limitKw: choice.offer.limitKw } : scalars;
  }

  cancel(): void {
    if (this.saved.choice.state === 'normal') return;
    this.save({ ...this.saved, choice: { state: 'normal' } });
  }

  processRequest(offer: NorwayCapacityChoiceOffer | null, scalars: CapacityScalarSettings, nowMs: number): boolean {
    const request = readNorwayCapacityChoiceRequest(this.settings.get(NORWAY_CAPACITY_CHOICE_REQUEST));
    if (request === null) return false;
    if (this.saved.outcome.state !== 'idle' && this.saved.outcome.requestId === request.id) return false;
    if (request.action === 'cancel') {
      this.save({ choice: { state: 'normal' }, outcome: {
        state: 'accepted', requestId: request.id, message: 'Normal capacity limit restored.',
      } });
      return true;
    }
    const current = request.offer;
    const matches = offer !== null && current.monthKey === norwayMonthKey(nowMs) && current.monthKey === offer.monthKey
      && current.tariffIdentity === offer.tariffIdentity && current.limitKw === offer.limitKw
      && current.revision === offer.revision;
    if (!matches || !scalars.capacityEnabled || scalars.periodMinutes !== 60) {
      this.save({ ...this.saved, outcome: {
        state: 'rejected', requestId: request.id, message: 'The capacity advice changed. Review the latest suggestion.',
      } });
      return false;
    }
    this.save({ configuration: this.captureConfiguration(), marginKw: scalars.marginKw,
      choice: { state: 'active', offer: current, normalLimitKw: scalars.limitKw }, outcome: {
      state: 'accepted', requestId: request.id, message: 'Capacity limit applied for this month.',
    } });
    return true;
  }

  private save(next: SavedChoice): void {
    this.settings.set(STATE_KEY, next);
    this.saved = next;
  }
}
