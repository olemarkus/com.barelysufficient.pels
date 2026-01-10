import Homey from 'homey';
import type { CombinedPriceData } from '../../lib/dailyBudget/dailyBudgetMath';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPricePng } from '../../lib/insights/planPriceImage';
import { normalizeDebugLoggingTopics } from '../../lib/utils/debugLogging';
import {
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
  DAILY_BUDGET_STATE,
  DEBUG_LOGGING_TOPICS,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

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

type DailyBudgetApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
};

type ImageBuffer = Buffer<ArrayBufferLike>;
type ImageStreamMetadata = {
  contentType: string;
  filename: string;
  contentLength?: number;
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

const PLAN_IMAGE_SETTINGS_KEYS = new Set([
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
  DAILY_BUDGET_STATE,
  'combined_prices',
  'price_optimization_enabled',
]);

const HOUR_MS = 60 * 60 * 1000;
const EMPTY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

const shouldSetCapability = (value: unknown, type: CapabilityEntry['type']) => {
  if (type === 'string') return typeof value === 'string' && value.length > 0;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean';
};

class PelsInsightsDevice extends Homey.Device {
  private planImage?: Homey.Image;
  private planImagePng: ImageBuffer = EMPTY_PNG;
  private planImageGeneration?: Promise<ImageBuffer>;
  private planImageTimer?: ReturnType<typeof setTimeout>;
  private planImageInterval?: ReturnType<typeof setInterval>;
  private planImageWarmupTimer?: ReturnType<typeof setTimeout>;
  private lastPlanImageKey?: string;

  private async removeDeprecatedCapability(capability: string): Promise<void> {
    if (!this.hasCapability(capability)) return;
    try {
      await this.removeCapability(capability);
    } catch (error) {
      this.error(`Failed to remove deprecated capability ${capability}`, error);
    }
  }

  async onInit(): Promise<void> {
    // Add capabilities if missing (for devices created before these were added)
    const requiredCapabilities = [
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

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }

    // Remove deprecated alarm_generic if present (replaced by pels_shortfall)
    await this.removeDeprecatedCapability('alarm_generic');
    await this.removeDeprecatedCapability('pels_shedding');
    await this.removeDeprecatedCapability('pels_daily_budget_pressure');
    await this.removeDeprecatedCapability('pels_daily_budget_used_kwh');
    await this.removeDeprecatedCapability('pels_daily_budget_allowed_kwh_now');

    // Initialize from current settings
    const initialMode = (this.homey.settings.get(OPERATING_MODE_SETTING) as string) || 'home';
    await this.updateMode(initialMode);
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
    await this.updateFromStatus();
    await this.initPlanImage();

    // Listen for settings changes
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
      if (PLAN_IMAGE_SETTINGS_KEYS.has(key)) {
        void this.refreshPlanImage({ force: true });
      }
    });
  }

  async onUninit(): Promise<void> {
    this.clearPlanImageTimers();
    await this.unregisterPlanImage();
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

  private async initPlanImage(): Promise<void> {
    if (this.planImage || !this.homey.images?.createImage) return;
    try {
      this.planImage = await this.homey.images.createImage();
      this.planImage.setStream((stream: NodeJS.WritableStream) => this.writePlanImageToStream(stream));
      await this.setCameraImage('plan_budget', 'Budget + Plan', this.planImage);
      await this.refreshPlanImage({ force: true });
      this.schedulePlanImageWarmup();
      this.schedulePlanImageRefresh();
    } catch (error) {
      this.error('Failed to initialize plan image', error);
    }
  }

  private schedulePlanImageRefresh(): void {
    if (this.planImageTimer || this.planImageInterval) return;
    const now = new Date();
    const next = new Date(now.getTime());
    next.setMinutes(0, 0, 0);
    next.setHours(now.getHours() + 1);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.planImageTimer = setTimeout(() => {
      this.planImageTimer = undefined;
      void this.refreshPlanImage({ force: true });
      this.planImageInterval = setInterval(() => {
        void this.refreshPlanImage({ force: true });
      }, HOUR_MS);
    }, delay);
  }

  private async refreshPlanImage(options: { force?: boolean } = {}): Promise<void> {
    if (!this.planImage) return;
    if (this.planImageGeneration) {
      this.logPlanImageDebug('Refresh skipped: generation already in progress');
      return;
    }
    try {
      const nowMs = Date.now();
      const snapshot = this.getDailyBudgetSnapshot();
      const key = this.resolvePlanImageKey(snapshot, nowMs);
      if (!options.force && this.lastPlanImageKey === key) {
        this.logPlanImageDebug(`Refresh skipped: cached key ${key}`);
        return;
      }
      this.logPlanImageDebug(`Refreshing image (force=${options.force === true}) key=${key}`);
      const png = await this.generatePlanImageBuffer(snapshot, nowMs);
      this.planImagePng = png;
      this.lastPlanImageKey = key;
      await this.planImage.update();
      this.logPlanImageDebug(`Image updated (${png.length} bytes)`);
    } catch (error) {
      this.error('Failed to refresh plan image', error);
    }
  }

  private resolvePlanImageKey(snapshot: DailyBudgetUiPayload | null, nowMs: number): string {
    if (snapshot) {
      return `${snapshot.dateKey}-${snapshot.currentBucketIndex}`;
    }
    return `${formatLocalDateKey(nowMs)}-${new Date(nowMs).getHours()}`;
  }

  private clearPlanImageTimers(): void {
    if (this.planImageTimer) {
      clearTimeout(this.planImageTimer);
      this.planImageTimer = undefined;
    }
    if (this.planImageInterval) {
      clearInterval(this.planImageInterval);
      this.planImageInterval = undefined;
    }
    if (this.planImageWarmupTimer) {
      clearTimeout(this.planImageWarmupTimer);
      this.planImageWarmupTimer = undefined;
    }
  }

  private async unregisterPlanImage(): Promise<void> {
    if (!this.planImage) return;
    try {
      await this.planImage.unregister();
    } catch (error) {
      this.error('Failed to unregister plan image', error);
    } finally {
      this.planImage = undefined;
    }
  }

  private getDailyBudgetSnapshot(): DailyBudgetUiPayload | null {
    const app = this.homey.app as DailyBudgetApp;
    if (app?.getDailyBudgetUiPayload) {
      return app.getDailyBudgetUiPayload();
    }
    return null;
  }

  private async getPlanImageForStream(): Promise<ImageBuffer> {
    if (this.planImageGeneration) return this.planImageGeneration;
    const generation = (async () => {
      const nowMs = Date.now();
      const snapshot = this.getDailyBudgetSnapshot();
      try {
        this.logPlanImageDebug('Generating image for stream');
        const png = await this.generatePlanImageBuffer(snapshot, nowMs);
        this.planImagePng = png;
        this.lastPlanImageKey = this.resolvePlanImageKey(snapshot, nowMs);
        this.logPlanImageDebug(`Generated image for stream (${png.length} bytes)`);
        return png;
      } catch (error) {
        this.error('Failed to generate plan image for stream', error);
        return this.planImagePng ?? EMPTY_PNG;
      } finally {
        this.planImageGeneration = undefined;
      }
    })();
    this.planImageGeneration = generation;
    return generation;
  }

  private async generatePlanImageBuffer(snapshot: DailyBudgetUiPayload | null, nowMs: number): Promise<ImageBuffer> {
    const combinedPrices = this.homey.settings.get('combined_prices') as CombinedPriceData | null;
    const png = await buildPlanPricePng({ snapshot, combinedPrices, nowMs });
    return Buffer.from(png);
  }

  private async writePlanImageToStream(stream: NodeJS.WritableStream): Promise<ImageStreamMetadata> {
    const imageStream = stream as NodeJS.WritableStream & {
      contentType?: string;
      filename?: string;
      contentLength?: number;
    };
    try {
      const png = await this.getPlanImageForStream();
      const meta = {
        contentType: 'image/png',
        filename: 'pels-plan.png',
        contentLength: png.length,
      };
      imageStream.contentType = meta.contentType;
      imageStream.filename = meta.filename;
      imageStream.contentLength = meta.contentLength;
      stream.end(png);
      return meta;
    } catch (error) {
      this.error('Failed to stream plan image', error);
      const fallback = this.planImagePng ?? EMPTY_PNG;
      const meta = {
        contentType: 'image/png',
        filename: 'pels-plan.png',
        contentLength: fallback.length,
      };
      imageStream.contentType = meta.contentType;
      imageStream.filename = meta.filename;
      imageStream.contentLength = meta.contentLength;
      stream.end(fallback);
      this.logPlanImageDebug('Stream fallback: using cached image');
      return meta;
    }
  }

  private schedulePlanImageWarmup(): void {
    if (this.planImageWarmupTimer) return;
    this.planImageWarmupTimer = setTimeout(() => {
      this.planImageWarmupTimer = undefined;
      if (this.planImagePng.length <= EMPTY_PNG.length) {
        this.logPlanImageDebug('Warmup refresh: placeholder image detected');
        void this.refreshPlanImage({ force: true });
      }
    }, 8000);
  }

  private logPlanImageDebug(message: string): void {
    const rawTopics = this.homey.settings.get(DEBUG_LOGGING_TOPICS) as unknown;
    const topics = normalizeDebugLoggingTopics(rawTopics);
    if (!topics.includes('daily_budget')) return;
    this.log(`[plan-image] ${message}`);
  }
}

function formatLocalDateKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export = PelsInsightsDevice;
