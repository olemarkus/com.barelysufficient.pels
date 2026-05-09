import type { PriceScheme, NorwayPriceModel } from './priceSettingsPersistence.ts';

export type StatusTone = 'ok' | 'warn';

export type StatusValue = { text: string; tone: StatusTone };

export type FlowStatus = {
  today: StatusValue;
  tomorrow: StatusValue;
};

export type HomeyStatus = {
  currency: string;
  currencyTone: StatusTone;
  today: StatusValue;
  tomorrow: StatusValue;
};

export type PriceOptDevice = {
  id: string;
  name: string;
  cheapDelta: number;
  expensiveDelta: number;
};

export type GridCompanyOption = {
  name: string;
  organizationNumber: string;
};

export type { PriceScheme, NorwayPriceModel };
