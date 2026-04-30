type SplitShares = {
  uncontrolled: number[];
  controlled: number[];
};

export const buildPlannedSplit = (params: {
  plannedKWh: number[];
  splitShares: SplitShares;
  controlledMinFloors?: number[];
  uncontrolledReserveFloors?: number[];
  previousPlannedUncontrolledKWh?: number[];
  previousPlannedControlledKWh?: number[];
  currentBucketIndex: number;
  shouldLockCurrent: boolean;
}): Array<{ plannedUncontrolled: number; plannedControlled: number }> => {
  const {
    plannedKWh,
    splitShares,
    controlledMinFloors,
    uncontrolledReserveFloors,
    previousPlannedUncontrolledKWh,
    previousPlannedControlledKWh,
    currentBucketIndex,
    shouldLockCurrent,
  } = params;
  const hasPreviousSplit = Array.isArray(previousPlannedUncontrolledKWh)
    && Array.isArray(previousPlannedControlledKWh)
    && previousPlannedUncontrolledKWh.length === plannedKWh.length
    && previousPlannedControlledKWh.length === plannedKWh.length;

  return splitShares.uncontrolled.map((_share, index) => {
    const planned = plannedKWh[index] ?? 0;
    const shouldPreservePreviousSplit = hasPreviousSplit
      && (index < currentBucketIndex || (shouldLockCurrent && index === currentBucketIndex));
    const preservedSplit = shouldPreservePreviousSplit
      ? resolvePreservedSplit({
        planned,
        previousUncontrolled: previousPlannedUncontrolledKWh?.[index],
        previousControlled: previousPlannedControlledKWh?.[index],
      })
      : null;
    if (preservedSplit) return preservedSplit;
    return resolveComputedSplit({
      planned,
      shareControlled: splitShares.controlled[index] ?? 0,
      controlledFloor: controlledMinFloors?.[index] ?? 0,
      uncontrolledReserve: uncontrolledReserveFloors?.[index] ?? 0,
    });
  });
};

function resolvePreservedSplit(params: {
  planned: number;
  previousUncontrolled: number | undefined;
  previousControlled: number | undefined;
}): { plannedUncontrolled: number; plannedControlled: number } | null {
  const { planned, previousUncontrolled, previousControlled } = params;
  if (!Number.isFinite(previousUncontrolled) || !Number.isFinite(previousControlled)) return null;
  const preservedUncontrolled = Math.max(0, previousUncontrolled as number);
  const preservedControlled = Math.max(0, previousControlled as number);
  const preservedTotal = preservedUncontrolled + preservedControlled;
  if (planned <= 0) {
    return {
      plannedUncontrolled: 0,
      plannedControlled: 0,
    };
  }
  if (preservedTotal <= 0) return null;
  const scale = planned / preservedTotal;
  return {
    plannedUncontrolled: preservedUncontrolled * scale,
    plannedControlled: preservedControlled * scale,
  };
}

function resolveComputedSplit(params: {
  planned: number;
  shareControlled: number;
  controlledFloor: number;
  uncontrolledReserve: number;
}): { plannedUncontrolled: number; plannedControlled: number } {
  const { planned, shareControlled, controlledFloor, uncontrolledReserve } = params;
  const plannedUncontrolledFloor = Math.min(planned, Math.max(0, uncontrolledReserve));
  const maxControlled = planned - plannedUncontrolledFloor;
  const plannedControlled = Math.min(
    maxControlled,
    Math.max(planned * shareControlled, controlledFloor),
  );
  return {
    plannedUncontrolled: Math.max(0, planned - plannedControlled),
    plannedControlled,
  };
}
