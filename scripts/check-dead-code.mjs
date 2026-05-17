#!/usr/bin/env node

import { execSync } from 'node:child_process';

function run(command) {
  try {
    const stdout = execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (error) {
    return {
      code: Number(error.status) || 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
    };
  }
}

function parseMadgeOrphans(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'));
}

function parseTsPrune(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const allowedOrphans = new Set([
  'app.ts',
  'api.ts',
  'packages/settings-ui/src/script.ts',
  'drivers/pels_insights/device.ts',
  'drivers/pels_insights/driver.ts',
  // Pure scheduler entrypoint for the deferred-objective planner; runtime integration follows separately.
  'lib/plan/deferredObjectives/index.ts',
]);

const deferredObjectiveBarrelExports = [
  'buildDeferredObjectiveDiagnostics',
  'buildDeferredObjectivePolicyHorizon',
  'createEmptyDeferredObjectiveSettings',
  'DeferredObjectiveDeadlineResolution',
  'DeferredObjectiveDiagnostic',
  'DeferredObjectiveDiagnosticReasonCode',
  'DeferredObjectivePolicyHorizonResult',
  'DeferredObjectivePolicyHorizonUnavailableReason',
  'DeferredObjectiveSettingsEntry',
  'DeferredObjectiveSettingsKind',
  'DeferredObjectiveSettingsV1',
  'emitDeferredObjectiveDiagnostics',
  'normalizeDeferredObjectiveSettings',
  'planDeferredObjectiveHorizon',
  'DeferredObjective',
  'DeferredObjectiveBucketPreference',
  'DeferredObjectiveCurrentBucketPlan',
  'DeferredObjectiveEnforcement',
  'DeferredObjectiveHorizonBucket',
  'DeferredObjectiveHorizonInput',
  'DeferredObjectiveHorizonPlan',
  'DeferredObjectiveHorizonStatus',
  'DeferredObjectiveHorizonStatusDetail',
  'DeferredObjectiveKind',
  'DeferredObjectivePlannedBucket',
  'resolveDeferredObjectiveDeadline',
  'DeferredObjectiveStep',
].join('|');

const allowedUnusedExportPatterns = [
  /:Infinity - prototype$/,
  /\(used in module\)$/,
  // TODO(dead-code): Include settings UI in this check and remove these exceptions.
  /^lib\/utils\/dateUtils\.ts:\d+ - getWeekStartInTimeZone$/,
  /^lib\/utils\/dateUtils\.ts:\d+ - formatDateInTimeZone$/,
  /^lib\/utils\/dateUtils\.ts:\d+ - formatTimeInTimeZone$/,
  /^lib\/utils\/settingsKeys\.ts:\d+ - DAILY_BUDGET_BREAKDOWN_ENABLED$/,
  /^lib\/utils\/planRebuildTrace\.ts:\d+ - clearPlanRebuildTracesForTests$/,
  /^lib\/price\/priceStore\.ts:\d+ - __resetRefetchGuardForTest$/,
  /^lib\/core\/deviceManagerHomeyApi\.ts:\d+ - setRestClient$/,
  /^lib\/core\/deviceManagerHomeyApi\.ts:\d+ - resetRestClient$/,
  // Compatibility barrel exports kept intentionally while call sites migrate off appPowerHelpers.ts.
  /^lib\/app\/appPowerHelpers\.ts:\d+ - schedulePlanRebuildFromPowerSample$/,
  /^lib\/app\/appPowerHelpers\.ts:\d+ - recordDailyBudgetCap$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_BOOTSTRAP_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_DEVICES_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_PLAN_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_POWER_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_PRICES_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_REFRESH_DEVICES_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_REFRESH_PRICES_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_REFRESH_GRID_TARIFF_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_LOG_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_RESET_POWER_STATS_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_RECOMPUTE_DAILY_BUDGET_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH$/,
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH$/,
  // Consumed by packages/settings-ui only; the runtime cannot value-import
  // deploy-excluded contract source files and instead duplicates the literal
  // in `lib/app/settingsUiAppRuntime.ts`.
  /^packages\/contracts\/src\/settingsUiApi\.ts:\d+ - SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX$/,
  /^packages\/contracts\/src\/targetCapabilities\.ts:\d+ - getTargetCapabilityStep$/,
  /^lib\/app\/smapsRollup\.ts:\d+ - _resetSmapsCacheForTests$/,
  /^lib\/app\/smapsRollup\.ts:\d+ - __resetSmapsDetailCacheForTests$/,
  /^lib\/app\/perfLogging\.ts:\d+ - __resetFdCountProbeForTests$/,
  /^lib\/utils\/opRssTracker\.ts:\d+ - __resetRssSupportProbeForTests$/,
  /^lib\/core\/deviceManagerNativeEv\.ts:\d+ - __resetNativeEvWiringLogStateForTests$/,
  /^lib\/core\/targetPowerContractWarn\.ts:\d+ - resetTargetPowerContractLogStateForTests$/,
  // Pure scheduler barrel kept intentionally until planner integration consumes it.
  new RegExp(`^lib\\/plan\\/deferredObjectives\\/index\\.ts:\\d+ - (${deferredObjectiveBarrelExports})$`),
  // Consumed by packages/settings-ui/src/ui/planDeviceCard.ts via cross-package relative import; ts-prune doesn't follow these.
  /^packages\/shared-domain\/src\/planStateLabels\.ts:\d+ - PLAN_STATE_LABEL$/,
  // Consumed by packages/settings-ui/src/ui/views/PlanDeviceCards.tsx via cross-package relative import; ts-prune ignores cross-package edges.
  /^packages\/shared-domain\/src\/deviceOverview\.ts:\d+ - resolveHeldStateActionLabel$/,
  // `deadlineLabels.ts` is pulled into ts-prune's graph by `flowCards/smartTaskTokens.ts`
  // importing `composeSmartTaskStatusNotificationText`; the rest of the file's exports
  // are consumed by `packages/settings-ui/**` which the runtime tsconfig excludes.
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_STATUS_LABELS$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_STATUS_CHIP_VARIANT$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveSmartTaskListStatus$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveSmartTaskListReadyByTone$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - DeadlinePlanCompletedReason$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - deadlineLabels$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveEvCardStateLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveKwhPerUnitProvenanceRows$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatConfidenceChipLabel$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatSmartTaskCurrentValueLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_HISTORY_EYEBROW$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_PAST_EMPTY_COPY$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatDeadlineCostMetaLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatDeadlineDeliveredSoFarLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveMissedHistoryRecourse$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - APPROX_GLYPH$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - revisionReason$/,
  /^packages\/shared-domain\/src\/deferredPlanHistory\.ts:\d+ - formatPlanHistoryCostAndDelivered$/,
  /^packages\/shared-domain\/src\/deferredPlanHistory\.ts:\d+ - formatPlanHistoryAbandonedSecondary$/,
  // Transitively reached from `deadlineLabels.ts`; consumed by settings UI bootstrap
  // and flowCards' deadline-objective settings reader.
  /^packages\/contracts\/src\/deferredObjectiveSettings\.ts:\d+ - normalizeDeferredObjectiveSettings$/,
];

const orphanResult = run(
  'madge --extensions ts --orphans app.ts api.ts flowCards drivers lib '
  + 'packages/settings-ui/src packages/contracts/src packages/shared-domain/src',
);
if (orphanResult.code !== 0) {
  console.error('deadcode: failed to run madge');
  if (orphanResult.stderr) console.error(orphanResult.stderr);
  process.exit(orphanResult.code);
}

const orphanFindings = parseMadgeOrphans(orphanResult.stdout)
  .filter((line) => !allowedOrphans.has(line));

const pruneResult = run('ts-prune -p tsconfig.runtime-unused.json');
if (pruneResult.code !== 0) {
  console.error('deadcode: failed to run ts-prune');
  if (pruneResult.stderr) console.error(pruneResult.stderr);
  process.exit(pruneResult.code);
}

const unusedExportFindings = parseTsPrune(pruneResult.stdout)
  .filter((line) => !allowedUnusedExportPatterns.some((pattern) => pattern.test(line)));

if (orphanFindings.length > 0 || unusedExportFindings.length > 0) {
  if (orphanFindings.length > 0) {
    console.error('deadcode: unexpected orphan files');
    orphanFindings.forEach((line) => console.error(`  - ${line}`));
  }
  if (unusedExportFindings.length > 0) {
    console.error('deadcode: unexpected unused exports');
    unusedExportFindings.forEach((line) => console.error(`  - ${line}`));
  }
  process.exit(1);
}

console.log('deadcode: no unexpected orphan files or unused exports.');
