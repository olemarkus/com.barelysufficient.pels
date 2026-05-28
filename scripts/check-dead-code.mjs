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
  'ConcurrentEligibleTaskTracker',
  'ELIGIBILITY_ABANDON_GRACE_MS',
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
  /^lib\/device\/transport\/managerHomeyApi\.ts:\d+ - setRestClient$/,
  /^lib\/device\/transport\/managerHomeyApi\.ts:\d+ - resetRestClient$/,
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
  /^lib\/diagnostics\/smapsRollup\.ts:\d+ - _resetSmapsCacheForTests$/,
  /^lib\/diagnostics\/smapsRollup\.ts:\d+ - __resetSmapsDetailCacheForTests$/,
  /^lib\/diagnostics\/perfLogging\.ts:\d+ - __resetFdCountProbeForTests$/,
  /^lib\/logging\/logger\.ts:\d+ - __resetLoggerCacheGuardForTest$/,
  /^lib\/utils\/opRssTracker\.ts:\d+ - __resetRssSupportProbeForTests$/,
  /^lib\/device\/managerNativeEv\.ts:\d+ - __resetNativeEvWiringLogStateForTests$/,
  /^lib\/device\/targetPowerContractWarn\.ts:\d+ - resetTargetPowerContractLogStateForTests$/,
  /^lib\/app\/appDeviceSupport\.ts:\d+ - __resetSeedSkipDedupeForTests$/,
  /^lib\/objectives\/noPowerSourceDiagnostic\.ts:\d+ - resetNoPowerSourceDiagnosticForTests$/,
  // Chunk 2 of the planner-detype refactor added these producer-side
  // helpers ahead of their full consumer set. `isCommandableNow`
  // graduated via `planExecutorSupport.canTurnOnDevice` (chunk 6).
  // `resolveBoostActive` graduated via `buildBoostPlanDeviceFields`
  // (chunk 5). `getCommandableNowReason` stays parked until the chunk-6
  // UI routing reroutes off-state reason strings onto it.
  /^lib\/device\/deviceActionProjection\.ts:\d+ - getCommandableNowReason$/,
  // Pure scheduler barrel kept intentionally until planner integration consumes it.
  new RegExp(`^lib\\/plan\\/deferredObjectives\\/index\\.ts:\\d+ - (${deferredObjectiveBarrelExports})$`),
  // Consumed by packages/settings-ui/src/ui/deviceDetail/evBoost.ts via cross-package relative import; ts-prune ignores cross-package edges.
  /^packages\/shared-domain\/src\/commandableNowReason\.ts:\d+ - EV_BOOST_BLOCK_REASONS$/,
  /^packages\/shared-domain\/src\/commandableNowReason\.ts:\d+ - EvBoostBlockReasonKey$/,
  // Consumed by packages/settings-ui/src/ui/planDeviceCard.ts via cross-package relative import; ts-prune doesn't follow these.
  /^packages\/shared-domain\/src\/planStateLabels\.ts:\d+ - PLAN_STATE_LABEL$/,
  // Consumed by packages/settings-ui/src/ui/views/PlanSteppedCard.tsx via cross-package relative import; ts-prune ignores cross-package edges.
  /^packages\/shared-domain\/src\/planStateLabels\.ts:\d+ - PLAN_STATE_HELD_FALLBACK_STATUS$/,
  // Consumed by packages/settings-ui/src/ui/views/PlanDeviceCards.tsx via cross-package relative import; ts-prune ignores cross-package edges.
  /^packages\/shared-domain\/src\/deviceOverview\.ts:\d+ - resolveHeldStateActionLabel$/,
  // `deadlineLabels.ts` is pulled into ts-prune's graph by `flowCards/smartTaskTokens.ts`
  // importing `composeSmartTaskStatusNotificationText`; the rest of the file's exports
  // are consumed by `packages/settings-ui/**` which the runtime tsconfig excludes.
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_STATUS_LABELS$/,
  // Consumed by `widgets/smart_tasks/` via the esbuild widget bundle, which
  // ts-prune (running against the runtime tsconfig that excludes `widgets/`)
  // doesn't see.
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_WIDGET_STATUS_LABELS$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_STATUS_CHIP_VARIANT$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveSmartTaskListStatus$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveSmartTaskListReadyByTone$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - DeadlinePlanCompletedReason$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - deadlineLabels$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveEvCardStateLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveKwhPerUnitProvenanceRows$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveChipConfidence$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveSmartTaskLearning$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatEnergyEstimateKWh$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - REVISION_REASON_FALLBACK_WITH_DETAIL$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatConfidenceChipLabel$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatSmartTaskListConfidenceChipLabel$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_EXTRA_PERMISSIONS_ROW_LABEL$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIMIT_LOWER_PRIORITY_DEVICES_NOTE$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatSmartTaskExtraPermissionsValue$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatSmartTaskCurrentValueLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_HISTORY_EYEBROW$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_PAST_EMPTY_COPY$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_ROW_LABELS$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_EMPTY_COPY$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LIST_LOAD_ERROR_COPY$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_BANNER_LOAD_ERROR_PREFIX$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_BANNER_UNAVAILABLE_TITLE$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_BANNER_UNAVAILABLE_FOR_DEVICE$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_BANNER_RECORD_NOT_FOUND_TITLE$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_BANNER_RECORD_NOT_FOUND_BODY$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_LOADING_LABEL$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_USAGE_RETURN_DEFAULT_HREF$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_USAGE_RETURN_LABEL$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - SMART_TASK_USAGE_RETURN_CONTEXT$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatDeadlineCostMetaLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - formatDeadlineDeliveredSoFarLine$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - resolveMissedHistoryRecourse$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - APPROX_GLYPH$/,
  /^packages\/shared-domain\/src\/deadlineLabels\.ts:\d+ - revisionReason$/,
  // Consumed by `packages/settings-ui/src/ui/{boot,capacity}.ts` via cross-package
  // relative import; ts-prune doesn't follow these edges. `isDebugLoggingScenarioId`
  // is reported `(used in module)` because `normalizeDebugLoggingScenarioIds`
  // references it in-file, so it does not need its own allowlist entry.
  /^packages\/shared-domain\/src\/utils\/debugLogging\.ts:\d+ - scenarioIdsToTopics$/,
  /^packages\/shared-domain\/src\/utils\/debugLogging\.ts:\d+ - topicsToScenarioIds$/,
  /^packages\/shared-domain\/src\/utils\/debugLogging\.ts:\d+ - normalizeDebugLoggingScenarioIds$/,
  // `formatRefinedMissCause` is consumed only by `deferredPlanHistory.ts`'s
  // `formatPlanHistoryMissedReason` (a settings-UI-facing helper the runtime
  // tsconfig excludes), so ts-prune sees no runtime importer. Its sibling
  // `resolveDeferredPlanHistoryMissAttribution` IS reached (the recorder's
  // structured-log builder imports it) and so is not flagged.
  /^packages\/shared-domain\/src\/deferredPlanHistoryAttribution\.ts:\d+ - formatRefinedMissCause$/,
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
