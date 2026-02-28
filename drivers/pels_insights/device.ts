import Homey from 'homey';
import type { CombinedPriceData } from '../../lib/dailyBudget/dailyBudgetMath';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPricePng } from '../../lib/insights/planPriceImage';
import { startRuntimeSpan } from '../../lib/utils/runtimeTrace';
import { normalizeDebugLoggingTopics } from '../../lib/utils/debugLogging';
import { getDateKeyInTimeZone, getZonedParts } from '../../lib/utils/dateUtils';
import {
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
  DAILY_BUDGET_RESET,
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

type ImageBuffer = Buffer;
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
  contentType: string;
  dayOffset: number;
  resolveDayKey: (snapshot: DailyBudgetUiPayload | null) => string | null;
  image?: Homey.Image;
  buffer: ImageBuffer;
  generation?: Promise<ImageBuffer>;
  lastKey?: string;
  lastRenderedAtMs?: number;
  lastStreamedAtMs?: number;
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
  COMBINED_PRICES,
  PRICE_OPTIMIZATION_ENABLED,
]);

const HOUR_MS = 60 * 60 * 1000;
const PLAN_IMAGE_STREAM_REFRESH_MIN_MS = 2 * 60 * 1000;
const PLAN_IMAGE_STREAM_ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
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
      contentType: 'image/png',
      dayOffset: 0,
      resolveDayKey: (snapshot) => snapshot?.todayKey ?? null,
      buffer: EMPTY_PNG,
    },
    {
      target: 'tomorrow',
      cameraId: 'plan_budget_tomorrow',
      cameraName: 'Budget and Price (Tomorrow)',
      filename: 'pels-plan-tomorrow.png',
      contentType: 'image/png',
      dayOffset: 1,
      resolveDayKey: (snapshot) => snapshot?.tomorrowKey ?? null,
      buffer: EMPTY_PNG,
    },
  ];
  private planImageTimer?: ReturnType<typeof setTimeout>;
  private planImageInterval?: ReturnType<typeof setInterval>;
  private planImageRenderCounter = 0;

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
        if (this.hasActivePlanImageDemand()) void this.refreshPlanImages();
        else this.invalidatePlanImageCache();
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
      if (this.hasActivePlanImageDemand()) void this.refreshPlanImages();
      this.planImageInterval = setInterval(() => {
        if (this.hasActivePlanImageDemand()) void this.refreshPlanImages();
      }, HOUR_MS);
    }, delay);
  }

  private async refreshPlanImages(options: { force?: boolean } = {}): Promise<void> {
    for (const [index] of this.planImages.entries()) {
      await this.refreshPlanImage(index, options);
    }
  }

  private async refreshPlanImage(
    index: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const slot = this.planImages[index];
    if (!slot) return;
    const image = slot.image;
    if (!image) return;
    if (slot.generation) {
      try {
        await slot.generation;
      } catch (error) {
        this.error(`Failed to refresh plan image ${slot.cameraId} (in-flight generation)`, error);
      }
      return;
    }
    const renderPromise = (async (): Promise<ImageBuffer> => {
      const stopSpan = startRuntimeSpan(`camera_chart_render(${slot.cameraId})`);
      const nowMs = Date.now();
      try {
        const snapshot = this.getDailyBudgetSnapshot();
        const dayKey = slot.resolveDayKey(snapshot);
        const combinedPrices = this.getCombinedPrices();
        const key = this.resolvePlanImageKey(snapshot, nowMs, dayKey, slot.dayOffset, combinedPrices);
        const current = this.planImages[index];
        if (!options.force && current?.lastKey === key) {
          this.logPlanImageDebug(`${slot.cameraId}: Refresh skipped: cached key ${key}`);
          return current?.buffer ?? slot.buffer;
        }
        const renderId = ++this.planImageRenderCounter;
        this.log(`[plan-image] ${slot.cameraId}: render start id=${renderId} force=${options.force === true} key=${key}`);
        this.logPlanImageDebug(`${slot.cameraId}: Refreshing image (force=${options.force === true}) key=${key}`);
        const renderStartedAtMs = Date.now();
        const payload = await this.generatePlanImagePayload(snapshot, dayKey, combinedPrices, slot.filename);
        const renderDurationMs = Date.now() - renderStartedAtMs;
        this.updatePlanImageSlot(index, {
          buffer: payload.buffer,
          contentType: payload.contentType,
          filename: payload.filename,
          lastKey: key,
          lastRenderedAtMs: nowMs,
        });
        await image.update();
        this.log(`[plan-image] ${slot.cameraId}: render done id=${renderId} ms=${renderDurationMs} bytes=${payload.buffer.length}`);
        this.logPlanImageDebug(`${slot.cameraId}: Image updated (${payload.buffer.length} bytes, ${renderDurationMs}ms)`);
        return payload.buffer;
      } finally {
        stopSpan();
      }
    })();
    this.updatePlanImageSlot(index, { generation: renderPromise });
    try {
      await renderPromise;
    } catch (error) {
      this.error(`Failed to refresh plan image ${slot.cameraId}`, error);
    } finally {
      const current = this.planImages[index];
      if (current?.generation === renderPromise) {
        this.updatePlanImageSlot(index, { generation: undefined });
      }
    }
  }

  private resolvePlanImageKey(
    snapshot: DailyBudgetUiPayload | null,
    nowMs: number,
    dayKey: string | null,
    dayOffset: number,
    combinedPrices?: CombinedPriceData | null,
  ): string {
    const resolvedDayKey = dayKey && dayKey.trim().length > 0 ? dayKey : null;
    const day = resolvedDayKey ? snapshot?.days?.[resolvedDayKey] ?? null : null;
    const timeZone = this.homey.clock.getTimezone();
    const dateKey = day?.dateKey
      ?? resolvedDayKey
      ?? this.resolveFallbackDateKey(nowMs, dayOffset, timeZone);
    const currentIndex = dayOffset === 0
      ? this.resolveFallbackIndex(day?.currentBucketIndex, nowMs, timeZone)
      : 'na';
    const budgetKey = this.buildBudgetKey(day);
    const priceKey = this.buildPriceKey(combinedPrices);
    return `${dateKey}-${currentIndex}-${budgetKey}-${priceKey}`;
  }

  private resolveFallbackDateKey(nowMs: number, dayOffset: number, timeZone: string): string {
    const fallbackDate = new Date(nowMs);
    if (dayOffset !== 0) {
      fallbackDate.setDate(fallbackDate.getDate() + dayOffset);
    }
    return getDateKeyInTimeZone(fallbackDate, timeZone);
  }

  private resolveFallbackIndex(rawIndex: number | null | undefined, nowMs: number, timeZone: string): number {
    if (typeof rawIndex === 'number' && Number.isFinite(rawIndex)) {
      return Math.max(0, rawIndex);
    }
    return getZonedParts(new Date(nowMs), timeZone).hour;
  }

  private buildBudgetKey(day: DailyBudgetDayPayload | null): string {
    if (!day) return 'budget-na';
    return `${day.budget.enabled ? 1 : 0}-${day.budget.dailyBudgetKWh}-${day.budget.priceShapingEnabled ? 1 : 0}`;
  }

  private buildPriceKey(combinedPrices?: CombinedPriceData | null): string {
    const prices = combinedPrices?.prices ?? [];
    const firstStartsAt = prices[0]?.startsAt ?? '';
    const lastStartsAt = prices[prices.length - 1]?.startsAt ?? '';
    const totalChecksum = prices.reduce((sum, entry) => sum + (Number.isFinite(entry.total) ? Math.round(entry.total * 100) : 0), 0);
    const priceKey = `${prices.length}-${firstStartsAt}-${lastStartsAt}-${totalChecksum}`;
    const unitKey = combinedPrices?.priceUnit ?? '';
    return `${priceKey}-${unitKey}`;
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

  private hasActivePlanImageDemand(nowMs: number = Date.now()): boolean {
    return this.planImages.some((slot) => typeof slot.lastStreamedAtMs === 'number' && (nowMs - slot.lastStreamedAtMs) <= PLAN_IMAGE_STREAM_ACTIVITY_WINDOW_MS);
  }

  private invalidatePlanImageCache(): void {
    for (const [index] of this.planImages.entries()) {
      this.updatePlanImageSlot(index, { lastKey: undefined });
    }
  }

  private shouldRefreshPlanImageForStream(params: {
    slot: PlanImageState;
    nowMs: number;
    key: string;
  }): boolean {
    const { slot, nowMs, key } = params;
    const hasCachedImage = slot.buffer.length > EMPTY_PNG.length;
    if (!hasCachedImage) return true;
    if (slot.lastKey === key) return false;
    const isCoolingDown = typeof slot.lastRenderedAtMs === 'number'
      && (nowMs - slot.lastRenderedAtMs) < PLAN_IMAGE_STREAM_REFRESH_MIN_MS;
    return !isCoolingDown;
  }

  private async getPlanImageForStream(index: number): Promise<ImageBuffer> {
    const slot = this.planImages[index];
    if (!slot) return EMPTY_PNG;
    const nowMs = Date.now();
    const snapshot = this.getDailyBudgetSnapshot();
    const dayKey = slot.resolveDayKey(snapshot);
    const combinedPrices = this.getCombinedPrices();
    const key = this.resolvePlanImageKey(snapshot, nowMs, dayKey, slot.dayOffset, combinedPrices);
    const current = this.planImages[index];

    // Reuse in-flight render work to avoid concurrent stream stampedes for the same slot.
    if (current?.generation) {
      await current.generation;
      return this.planImages[index]?.buffer ?? current.buffer ?? slot.buffer ?? EMPTY_PNG;
    }

    if (this.shouldRefreshPlanImageForStream({ slot, nowMs, key })) {
      await this.refreshPlanImage(index);
    }

    return this.planImages[index]?.buffer ?? slot.buffer ?? EMPTY_PNG;
  }

  private async generatePlanImagePayload(
    snapshot: DailyBudgetUiPayload | null,
    dayKey: string | null,
    combinedPrices?: CombinedPriceData | null,
    filename?: string,
  ): Promise<{ buffer: ImageBuffer; contentType: string; filename: string }> {
    const png = await buildPlanPricePng({ snapshot, combinedPrices, dayKey });
    return {
      buffer: Buffer.from(png),
      contentType: 'image/png',
      filename: filename ?? 'pels-plan.png',
    };
  }

  private getCombinedPrices(): CombinedPriceData | null {
    return this.homey.settings.get(COMBINED_PRICES) as CombinedPriceData | null;
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
        contentType: slot.contentType || 'image/png',
        filename: slot.filename,
        contentLength: png.length,
      };
      this.updatePlanImageSlot(index, { lastStreamedAtMs: Date.now() });
      imageStream.contentType = meta.contentType;
      imageStream.filename = meta.filename;
      imageStream.contentLength = meta.contentLength;
      stream.end(png);
      return meta;
    } catch (error) {
      this.error(`Failed to stream plan image ${slot.cameraId}`, error);
      const fallback = slot.buffer ?? EMPTY_PNG;
      const meta = {
        contentType: slot.contentType || 'image/png',
        filename: slot.filename,
        contentLength: fallback.length,
      };
      this.updatePlanImageSlot(index, { lastStreamedAtMs: Date.now() });
      imageStream.contentType = meta.contentType;
      imageStream.filename = meta.filename;
      imageStream.contentLength = meta.contentLength;
      stream.end(fallback);
      this.logPlanImageDebug(`${slot.cameraId}: Stream fallback: using cached image`);
      return meta;
    }
  }

  private logPlanImageDebug(message: string): void {
    const rawTopics = this.homey.settings.get(DEBUG_LOGGING_TOPICS) as unknown;
    const topics = normalizeDebugLoggingTopics(rawTopics);
    if (!topics.includes('daily_budget')) return;
    this.log(`[plan-image] ${message}`);
  }
}

export = PelsInsightsDevice;
