import Homey from 'homey';
import type { CombinedPriceData } from '../../lib/dailyBudget/dailyBudgetMath';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPricePng } from '../../lib/insights/planPriceImage';
import { normalizeDebugLoggingTopics } from '../../lib/utils/debugLogging';
import { formatLocalDateKey } from '../../lib/utils/dateUtils';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
  DAILY_BUDGET_STATE,
  DEBUG_LOGGING_TOPICS,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_ENABLED,
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

type PlanImageTarget = 'today' | 'tomorrow';

type PlanImageState = {
  target: PlanImageTarget;
  cameraId: string;
  cameraName: string;
  filename: string;
  dayOffset: number;
  resolveDayKey: (snapshot: DailyBudgetUiPayload | null) => string | null;
  image?: Homey.Image;
  png: ImageBuffer;
  generation?: Promise<ImageBuffer>;
  lastKey?: string;
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
  COMBINED_PRICES,
  PRICE_OPTIMIZATION_ENABLED,
]);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
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
  private planImages: PlanImageState[] = [
    {
      target: 'today',
      cameraId: 'plan_budget',
      cameraName: 'Budget and Price',
      filename: 'pels-plan.png',
      dayOffset: 0,
      resolveDayKey: (snapshot) => snapshot?.todayKey ?? null,
      png: EMPTY_PNG,
    },
    {
      target: 'tomorrow',
      cameraId: 'plan_budget_tomorrow',
      cameraName: 'Budget and Price (Tomorrow)',
      filename: 'pels-plan-tomorrow.png',
      dayOffset: 1,
      resolveDayKey: (snapshot) => snapshot?.tomorrowKey ?? null,
      png: EMPTY_PNG,
    },
  ];
  private planImageTimer?: ReturnType<typeof setTimeout>;
  private planImageInterval?: ReturnType<typeof setInterval>;
  private planImageWarmupTimer?: ReturnType<typeof setTimeout>;

  private updatePlanImageSlot(index: number, patch: Partial<PlanImageState>): PlanImageState {
    const current = this.planImages[index];
    if (!current) {
      throw new Error(`Plan image slot ${index} missing`);
    }
    const next = { ...current, ...patch };
    this.planImages[index] = next;
    return next;
  }

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
    await this.initPlanImages();

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
        void this.refreshPlanImages({ force: true });
      }
    });
  }

  async onUninit(): Promise<void> {
    this.clearPlanImageTimers();
    await this.unregisterPlanImages();
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

  private async initPlanImages(): Promise<void> {
    if (!this.homey.images?.createImage) return;
    for (const [index, slot] of this.planImages.entries()) {
      if (slot.image) continue;
      try {
        const image = await this.homey.images.createImage();
        this.updatePlanImageSlot(index, { image });
        image.setStream((stream: NodeJS.WritableStream) => this.writePlanImageToStream(index, stream));
        await this.setCameraImage(slot.cameraId, slot.cameraName, image);
      } catch (error) {
        this.error(`Failed to initialize plan image ${slot.cameraId}`, error);
      }
    }
    if (!this.planImages.some((slot) => slot.image)) return;
    await this.refreshPlanImages({ force: true });
    this.schedulePlanImageWarmup();
    this.schedulePlanImageRefresh();
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
      void this.refreshPlanImages({ force: true });
      this.planImageInterval = setInterval(() => {
        void this.refreshPlanImages({ force: true });
      }, HOUR_MS);
    }, delay);
  }

  private async refreshPlanImages(options: { force?: boolean } = {}): Promise<void> {
    for (const [index, slot] of this.planImages.entries()) {
      await this.refreshPlanImage(index, slot, options);
    }
  }

  private async refreshPlanImage(
    index: number,
    slot: PlanImageState,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!slot.image) return;
    if (slot.generation) {
      this.logPlanImageDebug(`${slot.cameraId}: Refresh skipped: generation already in progress`);
      return;
    }
    try {
      const nowMs = Date.now();
      const snapshot = this.getDailyBudgetSnapshot();
      const dayKey = slot.resolveDayKey(snapshot);
      const key = this.resolvePlanImageKey(snapshot, nowMs, dayKey, slot.dayOffset);
      if (!options.force && slot.lastKey === key) {
        this.logPlanImageDebug(`${slot.cameraId}: Refresh skipped: cached key ${key}`);
        return;
      }
      this.logPlanImageDebug(`${slot.cameraId}: Refreshing image (force=${options.force === true}) key=${key}`);
      const png = await this.generatePlanImageBuffer(snapshot, dayKey);
      this.updatePlanImageSlot(index, { png, lastKey: key });
      await slot.image.update();
      this.logPlanImageDebug(`${slot.cameraId}: Image updated (${png.length} bytes)`);
    } catch (error) {
      this.error(`Failed to refresh plan image ${slot.cameraId}`, error);
    }
  }

  private resolvePlanImageKey(
    snapshot: DailyBudgetUiPayload | null,
    nowMs: number,
    dayKey: string | null,
    dayOffset: number,
  ): string {
    const resolvedDayKey = dayKey && dayKey.trim().length > 0 ? dayKey : null;
    const day = resolvedDayKey ? snapshot?.days?.[resolvedDayKey] ?? null : null;
    const dateKey = day?.dateKey ?? resolvedDayKey ?? formatLocalDateKey(nowMs + dayOffset * DAY_MS);
    const rawIndex = day?.currentBucketIndex;
    const fallbackIndex = new Date(nowMs).getHours();
    const currentIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
      ? Math.max(0, rawIndex)
      : fallbackIndex;
    return `${dateKey}-${currentIndex}`;
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

  private async unregisterPlanImages(): Promise<void> {
    for (const [index, slot] of this.planImages.entries()) {
      if (!slot.image) continue;
      try {
        await slot.image.unregister();
      } catch (error) {
        this.error(`Failed to unregister plan image ${slot.cameraId}`, error);
      } finally {
        this.updatePlanImageSlot(index, { image: undefined });
      }
    }
  }

  private getDailyBudgetSnapshot(): DailyBudgetUiPayload | null {
    const app = this.homey.app as DailyBudgetApp;
    if (app?.getDailyBudgetUiPayload) {
      return app.getDailyBudgetUiPayload();
    }
    return null;
  }

  private async getPlanImageForStream(index: number): Promise<ImageBuffer> {
    const slot = this.planImages[index];
    if (!slot) return EMPTY_PNG;
    if (slot.generation) return slot.generation;
    const generation = (async () => {
      const nowMs = Date.now();
      const snapshot = this.getDailyBudgetSnapshot();
      const dayKey = slot.resolveDayKey(snapshot);
      try {
        this.logPlanImageDebug(`${slot.cameraId}: Generating image for stream`);
        const png = await this.generatePlanImageBuffer(snapshot, dayKey);
        const updated = this.updatePlanImageSlot(index, {
          png,
          lastKey: this.resolvePlanImageKey(snapshot, nowMs, dayKey, slot.dayOffset),
        });
        this.logPlanImageDebug(`${slot.cameraId}: Generated image for stream (${png.length} bytes)`);
        return updated.png;
      } catch (error) {
        this.error(`Failed to generate plan image for stream ${slot.cameraId}`, error);
        return slot.png ?? EMPTY_PNG;
      } finally {
        this.updatePlanImageSlot(index, { generation: undefined });
      }
    })();
    this.updatePlanImageSlot(index, { generation });
    return generation;
  }

  private async generatePlanImageBuffer(
    snapshot: DailyBudgetUiPayload | null,
    dayKey: string | null,
  ): Promise<ImageBuffer> {
    const combinedPrices = this.homey.settings.get(COMBINED_PRICES) as CombinedPriceData | null;
    const png = await buildPlanPricePng({ snapshot, combinedPrices, dayKey });
    return Buffer.from(png);
  }

  private async writePlanImageToStream(
    index: number,
    stream: NodeJS.WritableStream,
  ): Promise<ImageStreamMetadata> {
    const slot = this.planImages[index];
    if (!slot) {
      stream.end(EMPTY_PNG);
      return {
        contentType: 'image/png',
        filename: 'pels-plan-missing.png',
        contentLength: EMPTY_PNG.length,
      };
    }
    const imageStream = stream as NodeJS.WritableStream & {
      contentType?: string;
      filename?: string;
      contentLength?: number;
    };
    try {
      const png = await this.getPlanImageForStream(index);
      const meta = {
        contentType: 'image/png',
        filename: slot.filename,
        contentLength: png.length,
      };
      imageStream.contentType = meta.contentType;
      imageStream.filename = meta.filename;
      imageStream.contentLength = meta.contentLength;
      stream.end(png);
      return meta;
    } catch (error) {
      this.error(`Failed to stream plan image ${slot.cameraId}`, error);
      const fallback = slot.png ?? EMPTY_PNG;
      const meta = {
        contentType: 'image/png',
        filename: slot.filename,
        contentLength: fallback.length,
      };
      imageStream.contentType = meta.contentType;
      imageStream.filename = meta.filename;
      imageStream.contentLength = meta.contentLength;
      stream.end(fallback);
      this.logPlanImageDebug(`${slot.cameraId}: Stream fallback: using cached image`);
      return meta;
    }
  }

  private schedulePlanImageWarmup(): void {
    if (this.planImageWarmupTimer) return;
    this.planImageWarmupTimer = setTimeout(() => {
      this.planImageWarmupTimer = undefined;
      const needsWarmup = this.planImages.some((slot) => (
        slot.image && slot.png.length <= EMPTY_PNG.length
      ));
      if (needsWarmup) {
        this.logPlanImageDebug('Warmup refresh: placeholder image detected');
        void this.refreshPlanImages({ force: true });
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

export = PelsInsightsDevice;
