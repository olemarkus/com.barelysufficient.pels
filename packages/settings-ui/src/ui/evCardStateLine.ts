import { resolveEvCardStateLine } from '../../../shared-domain/src/deadlineLabels.ts';
import { state } from './state.ts';

const formatEvCardTime = (ms: number): string => (
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
);

/**
 * Each charger's EV smart-task line ("Charging · planned finish 06:30"), from the
 * battery-level tasks the UI already holds for the Smart task chip. Only devices
 * with a live task and a line that applies are present. The on/off charger card
 * shows the line when the device's own status carries no reason.
 */
export const resolveEvCardStateLines = (nowMs: number): ReadonlyMap<string, string> => {
  const lines = new Map<string, string>();
  const objectives = state.deferredObjectiveSettings?.objectivesByDeviceId ?? {};
  for (const [deviceId, objective] of Object.entries(objectives)) {
    if (!objective.enabled || objective.kind !== 'ev_soc') continue;
    if (!Number.isFinite(objective.deadlineAtMs) || objective.deadlineAtMs <= nowMs) continue;
    const activePlan = state.deferredObjectiveActivePlans?.plansByDeviceId?.[deviceId];
    const stateLine = resolveEvCardStateLine({
      hours: activePlan?.latest?.hours ?? [],
      nowMs,
      isPlugOutPaused: activePlan?.diagnosticReasonCode === 'objective_invalid_session',
      formatTime: formatEvCardTime,
    });
    if (stateLine.kind !== 'none') lines.set(deviceId, stateLine.text);
  }
  return lines;
};
