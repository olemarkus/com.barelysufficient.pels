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
  'settings/src/script.ts',
  'drivers/pels_insights/device.ts',
  'drivers/pels_insights/driver.ts',
]);

const allowedUnusedExportPatterns = [
  /:Infinity - prototype$/,
  /\(used in module\)$/,
  // TODO(dead-code): Include settings UI in this check and remove these exceptions.
  /^lib\/utils\/dateUtils\.ts:\d+ - getWeekStartInTimeZone$/,
  /^lib\/utils\/dateUtils\.ts:\d+ - formatDateInTimeZone$/,
  /^lib\/utils\/dateUtils\.ts:\d+ - formatTimeInTimeZone$/,
  /^lib\/utils\/settingsKeys\.ts:\d+ - DAILY_BUDGET_BREAKDOWN_ENABLED$/,
];

const orphanResult = run('madge --extensions ts --orphans app.ts flowCards drivers lib settings/src');
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
