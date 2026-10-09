// The energy and cost lines of a smart-task plan preview, as the
// create_smart_task and starvation_rescue widgets show them. Browser-safe:
// bundled into each widget's `public/index.js` IIFE.
import type { DeferredObjectivePlanPreviewEstimate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import {
  formatDeadlineCostMetaLine,
  formatEnergyEstimateKWh,
} from '../../packages/shared-domain/src/deadlineLabels';

// "<energyLabel>: <estimate>", or null when the preview has no energy estimate.
export const formatPreviewEnergyLine = (
  estimate: DeferredObjectivePlanPreviewEstimate,
  energyLabel: string,
): string | null => {
  if (estimate.energyEstimateKWh === null) return null;
  return `${energyLabel}: ${formatEnergyEstimateKWh({
    energyPlannedKWh: estimate.energyEstimateKWh,
    energyExpectedKWh: estimate.energyExpectedKWh,
  })}`;
};

// "Cost ≈ 4.20 kr", or null when no price was available for the scheduled hours.
export const formatPreviewCostLine = (estimate: DeferredObjectivePlanPreviewEstimate): string | null => {
  if (estimate.costEstimate === null || !estimate.costUnit) return null;
  return formatDeadlineCostMetaLine({
    plannedTotalCost: estimate.costEstimate,
    deliveredCost: null,
    costUnit: estimate.costUnit,
  });
};
