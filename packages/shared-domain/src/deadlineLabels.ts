import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings.js';

export type DeadlineLabels = {
  kindChipLabel: string;
  activeChipLabel: string;
  waitingChipLabel: string;
  deviceSeriesName: string;
  backgroundSeriesName: string;
  planTooltipActive: string;
  planTooltipIdle: string;
  pendingHeroHeadline: string;
  pendingHeroBody: string;
  targetUnit: '°C' | '%';
};

const DEADLINE_LABELS: Record<DeferredObjectiveSettingsKind, DeadlineLabels> = {
  temperature: {
    kindChipLabel: 'Temperature',
    activeChipLabel: 'Heating',
    waitingChipLabel: 'Heat queued',
    deviceSeriesName: 'Heating',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Heat',
    planTooltipIdle: 'Idle',
    pendingHeroHeadline: 'Waiting for tomorrow’s prices',
    pendingHeroBody: 'The heat plan is computed once tomorrow’s prices arrive.',
    targetUnit: '°C',
  },
  ev_soc: {
    kindChipLabel: 'EV',
    activeChipLabel: 'Charging',
    waitingChipLabel: 'Charge queued',
    deviceSeriesName: 'Charging',
    backgroundSeriesName: 'Background usage',
    planTooltipActive: 'Charge',
    planTooltipIdle: 'Idle',
    pendingHeroHeadline: 'Waiting for tomorrow’s prices',
    pendingHeroBody: 'The charging plan is computed once tomorrow’s prices arrive.',
    targetUnit: '%',
  },
};

export const deadlineLabels = (kind: DeferredObjectiveSettingsKind): DeadlineLabels => DEADLINE_LABELS[kind];
