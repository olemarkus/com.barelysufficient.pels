import Homey from 'homey';
import { OPERATING_MODE_SETTING } from '../../lib/utils/settingsKeys';
import { getAllModes } from '../../lib/utils/capacityHelpers';
import { buildModeEnumValues } from './modeEnum';

type StatusData = {
  headroomKw?: number;
  hourlyLimitKw?: number;
  hourlyUsageKwh?: number;
  dailyBudgetRemainingKwh?: number;
  dailyBudgetExceeded?: boolean;
  limitReason?: 'none' | 'hourly' | 'daily' | 'both';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapHeadroomKw?: number | null;
  controlledKw?: number;
  uncontrolledKw?: number;
  priceLevel?: 'cheap' | 'normal' | 'expensive' | 'unknown';
  devicesOn?: number;
  devicesOff?: number;
};

type CapabilityEntry = {
  key: keyof StatusData;
  id: string;
  type: 'string' | 'number' | 'boolean';
};

const STATUS_CAPABILITY_MAP: CapabilityEntry[] = [
  { key: 'headroomKw', id: 'pels_headroom', type: 'number' },
  { key: 'hourlyLimitKw', id: 'pels_hourly_limit_kw', type: 'number' },
  { key: 'hourlyUsageKwh', id: 'pels_hourly_usage', type: 'number' },
  { key: 'dailyBudgetRemainingKwh', id: 'pels_daily_budget_remaining_kwh', type: 'number' },
  { key: 'dailyBudgetExceeded', id: 'pels_daily_budget_exceeded', type: 'boolean' },
  { key: 'limitReason', id: 'pels_limit_reason', type: 'string' },
  { key: 'controlledKw', id: 'pels_controlled_power', type: 'number' },
  { key: 'uncontrolledKw', id: 'pels_uncontrolled_power', type: 'number' },
  { key: 'priceLevel', id: 'pels_price_level', type: 'string' },
  { key: 'devicesOn', id: 'pels_devices_on', type: 'number' },
  { key: 'devicesOff', id: 'pels_devices_off', type: 'number' },
];

const REQUIRED_CAPABILITIES = [
  'mode_indicator',
  'pels_shortfall',
  'pels_headroom',
  'pels_hourly_limit_kw',
  'pels_hourly_usage',
  'pels_daily_budget_remaining_kwh',
  'pels_daily_budget_exceeded',
  'pels_limit_reason',
  'pels_controlled_power',
  'pels_uncontrolled_power',
  'pels_price_level',
  'pels_devices_on',
  'pels_devices_off',
];

const RETIRED_CAPABILITIES = [
  'alarm_generic',
  'pels_shedding',
  'pels_daily_budget_pressure',
  'pels_daily_budget_used_kwh',
  'pels_daily_budget_allowed_kwh_now',
  'pels_insights',
];

const RETIRED_PLAN_IMAGE_IDS = [
  'plan_budget',
  'plan_budget_tomorrow',
];

const MODE_SOURCE_SETTING_KEYS: ReadonlySet<string> = new Set([
  OPERATING_MODE_SETTING,
  'capacity_priorities',
  'mode_device_targets',
]);

const DEFAULT_MODE = 'Home';

const shouldSetCapability = (value: unknown, type: CapabilityEntry['type']) => {
  if (type === 'string') return typeof value === 'string' && value.length > 0;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean';
};

const isMissingRetiredPlanImageError = (error: unknown): boolean => (
  error instanceof Error && /not found|invalid image/i.test(error.message)
);

class PelsInsightsDevice extends Homey.Device {
  private async ensureRequiredCapabilities(): Promise<void> {
    for (const capability of REQUIRED_CAPABILITIES) {
      if (this.hasCapability(capability)) continue;
      await this.addCapability(capability);
    }
  }

  private async removeDeprecatedCapability(capability: string): Promise<void> {
    if (!this.hasCapability(capability)) return;
    try {
      await this.removeCapability(capability);
    } catch (error) {
      this.error(`Failed to remove deprecated capability ${capability}`, error);
    }
  }

  private async removeRetiredPlanImagesFromDevice(): Promise<void> {
    if (!this.homey.images?.getImage) return;

    for (const imageId of RETIRED_PLAN_IMAGE_IDS) {
      try {
        const image = this.homey.images.getImage(imageId);
        await image.unregister();
      } catch (error) {
        if (isMissingRetiredPlanImageError(error)) continue;
        this.error(`Failed to remove retired plan image ${imageId} from device`, error);
      }
    }
  }

  async onInit(): Promise<void> {
    await this.ensureRequiredCapabilities();

    for (const capability of RETIRED_CAPABILITIES) {
      await this.removeDeprecatedCapability(capability);
    }

    await this.refreshModeOptions();
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
    await this.updateFromStatus();
    await this.removeRetiredPlanImagesFromDevice();

    this.registerCapabilityListener('mode_indicator', async (value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) return;
      await this.commitModeSelection(value.trim());
    });

    this.homey.settings.on('set', async (key: string) => {
      if (MODE_SOURCE_SETTING_KEYS.has(key)) {
        await this.refreshModeOptions();
      }

      if (key === 'capacity_in_shortfall') {
        await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
      }

      if (key === 'pels_status') {
        await this.updateFromStatus();
      }
    });
  }

  private modeSelectionSeq = 0;

  private async commitModeSelection(mode: string): Promise<void> {
    // Sequence each selection so a stale failed write cannot revert the tile
    // over a newer tap. Rapid taps trigger overlapping read-modify-write cycles;
    // the async revert below must only fire when this is still the latest one.
    const requestSeq = ++this.modeSelectionSeq;
    // Capture the mode the runtime is currently committed to *before* writing,
    // so we can roll the tile back if the settings write is rejected. The
    // settings store still holds the old value on failure (the write did not
    // land), so this is the value the runtime will keep acting on.
    const committedMode = this.getActiveMode();
    try {
      // `ManagerSettings.set` is typed as returning `void`; resolving through a
      // Promise turns any synchronous throw into a catchable rejection without
      // awaiting a non-thenable.
      await Promise.resolve(this.homey.settings.set(OPERATING_MODE_SETTING, mode));
    } catch (error) {
      this.error('Failed to commit mode selection', error);
      // Revert the tile to the runtime's true mode so it cannot silently
      // display a mode the controller never adopted — but only if no newer
      // selection has started, so we don't clobber a later successful tap.
      if (requestSeq === this.modeSelectionSeq) {
        await this.updateMode(committedMode);
      }
    }
  }

  private getActiveMode(): string {
    const raw: unknown = this.homey.settings.get(OPERATING_MODE_SETTING);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_MODE;
  }

  private getConfiguredModes(): Set<string> {
    const activeMode = this.getActiveMode();
    const priorities = (this.homey.settings.get('capacity_priorities') as Record<string, Record<string, number>>) || {};
    const targets = (this.homey.settings.get('mode_device_targets') as Record<string, Record<string, number>>) || {};
    return getAllModes(activeMode, priorities, targets);
  }

  async refreshModeOptions(): Promise<void> {
    const activeMode = this.getActiveMode();
    const values = buildModeEnumValues(activeMode, this.getConfiguredModes());
    try {
      await this.setCapabilityOptions('mode_indicator', { values });
    } catch (error) {
      this.error('Failed to refresh mode_indicator values', error);
    }
    await this.updateMode(activeMode);
  }

  async updateMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('mode_indicator', mode);
    } catch (error) {
      this.error('Failed to update mode_indicator', error);
    }
  }

  async updateShortfall(inShortfall: boolean): Promise<void> {
    try {
      await this.setCapabilityValue('pels_shortfall', Boolean(inShortfall));
    } catch (error) {
      this.error('Failed to update shortfall alarm', error);
    }
  }

  async updateFromStatus(): Promise<void> {
    const status = this.homey.settings.get('pels_status') as StatusData | null;
    if (!status) return;

    try {
      for (const { key, id, type } of STATUS_CAPABILITY_MAP) {
        const value = status[key];
        if (shouldSetCapability(value, type)) {
          await this.setCapabilityValue(id, value);
        }
      }
    } catch (error) {
      this.error('Failed to update status capabilities', error);
    }
  }
}

export = PelsInsightsDevice;
