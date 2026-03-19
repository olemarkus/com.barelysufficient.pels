import Homey from 'homey';
import { OPERATING_MODE_SETTING } from '../../lib/utils/settingsKeys';

type StatusData = {
  headroomKw?: number;
  hourlyLimitKw?: number;
  hourlyUsageKwh?: number;
  dailyBudgetRemainingKwh?: number;
  dailyBudgetExceeded?: boolean;
  limitReason?: 'none' | 'hourly' | 'daily' | 'both';
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
];

const RETIRED_PLAN_IMAGE_IDS = [
  'plan_budget',
  'plan_budget_tomorrow',
];

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

    const initialMode = (this.homey.settings.get(OPERATING_MODE_SETTING) as string) || 'home';
    await this.updateMode(initialMode);
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
    await this.updateFromStatus();
    await this.removeRetiredPlanImagesFromDevice();

    this.homey.settings.on('set', async (key: string) => {
      if (key === OPERATING_MODE_SETTING) {
        const mode = (this.homey.settings.get(OPERATING_MODE_SETTING) as string) || 'home';
        await this.updateMode(mode);
      }

      if (key === 'capacity_in_shortfall') {
        await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
      }

      if (key === 'pels_status') {
        await this.updateFromStatus();
      }
    });
  }

  async updateMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('pels_insights', mode);
    } catch (error) {
      this.error('Failed to update pels insights', error);
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
