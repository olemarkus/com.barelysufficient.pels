import type {
  SmartTasksWidgetEndedRow,
  SmartTasksWidgetRow,
} from '../../smart_tasks/src/smartTasksWidgetTypes';
import { setLine } from '../widgetDom';
import { renderTrajectoryChart } from './trajectoryChart';

// The smart-task detail panel, shared by the widgets that open one (Smart task
// list, Device insight). Each host carries the panel's markup in its own
// index.html (a test keeps the copies identical) and owns when it shows; this
// module only fills it from a producer-built row.

export type DetailTargets = {
  detailView: HTMLElement;
  detailBackBtn: HTMLButtonElement;
  detailHeaderEl: HTMLElement;
  detailChipEl: HTMLElement;
  detailDeadlineEl: HTMLElement;
  detailChartEl: HTMLElement;
  detailTargetEl: HTMLElement;
  detailWhyEl: HTMLElement;
  detailRecourseEl: HTMLElement;
  detailMetaEl: HTMLElement;
  detailConfidenceEl: HTMLElement;
};

// The panel's plain HTMLElement slots, keyed by the DetailTargets field they
// fill; `detailBackBtn` is resolved separately because it needs the button type.
const DETAIL_ELEMENTS = {
  detailView: '[data-detail-view]',
  detailHeaderEl: '[data-detail-name]',
  detailChipEl: '[data-detail-chip]',
  detailDeadlineEl: '[data-detail-deadline]',
  detailChartEl: '[data-detail-chart]',
  detailTargetEl: '[data-detail-target]',
  detailWhyEl: '[data-detail-why]',
  detailRecourseEl: '[data-detail-recourse]',
  detailMetaEl: '[data-detail-meta]',
  detailConfidenceEl: '[data-detail-confidence]',
} as const satisfies Record<Exclude<keyof DetailTargets, 'detailBackBtn'>, string>;

/** The panel's elements in `widgetDocument`, or null when its markup is incomplete. */
export const resolveDetailTargets = (widgetDocument: Document): DetailTargets | null => {
  const elements: Partial<Record<keyof typeof DETAIL_ELEMENTS, HTMLElement>> = {};
  for (const [key, selector] of Object.entries(DETAIL_ELEMENTS)) {
    const element = widgetDocument.querySelector(selector);
    if (!(element instanceof HTMLElement)) return null;
    elements[key as keyof typeof DETAIL_ELEMENTS] = element;
  }
  const detailBackBtn = widgetDocument.querySelector('[data-detail-back]');
  if (!(detailBackBtn instanceof HTMLButtonElement)) return null;
  return { ...(elements as Record<keyof typeof DETAIL_ELEMENTS, HTMLElement>), detailBackBtn };
};

export const formatTaskValue = (value: number, unitSymbol: '°C' | '%' | 'kWh'): string => {
  const rounded = Math.round(value * 10) / 10;
  const text = rounded % 1 === 0 ? `${Math.round(rounded)}` : rounded.toFixed(1);
  return `${text} ${unitSymbol}`;
};

export const formatTargetSentence = (verb: string, targetValue: number, unitSymbol: '°C' | '%' | 'kWh'): string => (
  `${verb} ${formatTaskValue(targetValue, unitSymbol)}`
);

// Draws the trajectory chart, or hides the container when there's nothing
// chartable so the text lines carry the panel.
// Shown BEFORE drawing, so the chart measures its laid-out size.
const renderChart = (el: HTMLElement, chart: SmartTasksWidgetRow['chart']): void => {
  /* eslint-disable no-param-reassign -- `el` is a DOM write sink. */
  el.hidden = false;
  const drawn = chart !== null && renderTrajectoryChart(el, chart);
  el.hidden = !drawn;
  /* eslint-enable no-param-reassign */
};

export const renderActiveDetail = (targets: DetailTargets, row: SmartTasksWidgetRow): void => {
  const {
    detailHeaderEl, detailChipEl, detailDeadlineEl, detailChartEl, detailTargetEl,
    detailWhyEl, detailRecourseEl, detailMetaEl, detailConfidenceEl,
  } = targets;
  detailHeaderEl.textContent = row.deviceName;
  detailChipEl.textContent = row.statusLabel;
  detailChipEl.dataset.tone = row.tone;
  setLine(detailDeadlineEl, `${row.etaVerb} ${row.deadlineLongLabel}`);
  // Detail target line repeats the action verb so it stands on its own.
  detailTargetEl.textContent = formatTargetSentence(row.targetActionVerb, row.targetValue, row.unitSymbol);
  detailTargetEl.hidden = false;
  setLine(detailWhyEl, row.whyLabel);
  setLine(detailRecourseEl, row.recourseHint);
  setLine(detailMetaEl, row.planMetaLabel);
  setLine(detailConfidenceEl, row.confidenceLabel);
  // Last: the chart fills the room the text lines leave.
  renderChart(detailChartEl, row.chart);
};

export const renderEndedDetail = (targets: DetailTargets, row: SmartTasksWidgetEndedRow): void => {
  const {
    detailHeaderEl, detailChipEl, detailDeadlineEl, detailChartEl, detailTargetEl,
    detailWhyEl, detailRecourseEl, detailMetaEl, detailConfidenceEl,
  } = targets;
  detailHeaderEl.textContent = row.deviceName;
  detailChipEl.textContent = row.outcomeLabel;
  detailChipEl.dataset.tone = row.outcomeTone;
  setLine(detailDeadlineEl, row.finishedLabel);
  // Headline = the progress recap ("38 → 55 · target 55 °C") — the postmortem
  // story — falling back to the plain goal when start/final couldn't be resolved.
  detailTargetEl.textContent = row.progressLabel
    ?? formatTargetSentence(row.targetActionVerb, row.targetValue, row.unitSymbol);
  detailTargetEl.hidden = false;
  // Succeeded → "reached at HH:MM"; Missed → the blameless why sentence + the
  // budget/device recourse hint. Abandoned carries neither.
  setLine(detailWhyEl, row.reachedAtLabel ?? row.whyLabel);
  setLine(detailRecourseEl, row.recourseHint);
  setLine(detailMetaEl, null);
  setLine(detailConfidenceEl, null);
  // Last: the chart fills the room the text lines leave.
  renderChart(detailChartEl, row.chart);
};
