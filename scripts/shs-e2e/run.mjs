#!/usr/bin/env node
// The SHS suite: PELS end to end on a Homey Self-Hosted Server, from a clean
// install. Unlike the runtime e2e (`test/e2e/`), nothing here is a mock of
// Homey: the scenarios pair test-devices mocks, set PELS up through the
// settings keys and routes the settings UI uses, and read back what PELS does
// to the devices and what it serves the UI.
//
//   npm run shs:e2e                        every scenario, after a clean install
//   npm run shs:e2e -- --scenario drift-breaker
//   npm run shs:e2e -- --skip-install      reuse the box as the last run left it
//
// It installs test-devices (`TEST_DEVICES_DIR`, default ~/dev/test-devices) and
// then this checkout of PELS with `homey app install --clean`, so the box loses
// every paired mock and all PELS settings: run it only on a box set aside for it.
// `with-homey-shs2 npm run shs:e2e` targets the second box. A `homey app run` on
// this machine that holds either app on the box is stopped first.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PELS_APP_ID,
  TEST_DEVICES_APP_ID,
  commitOf,
  createHomeyApi,
  createPels,
  installClean,
  resolveBox,
  stopRunSessions,
} from './lab.mjs';
import { driftBreaker } from './scenarios/driftBreaker.mjs';

const SCENARIOS = [driftBreaker];

const PELS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DEVICES_DIR = process.env.TEST_DEVICES_DIR || join(homedir(), 'dev', 'test-devices');

const parseArgs = (argv) => {
  const scenarioAt = argv.indexOf('--scenario');
  return {
    skipInstall: argv.includes('--skip-install'),
    scenario: scenarioAt >= 0 ? argv[scenarioAt + 1] : undefined,
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = args.scenario ? SCENARIOS.filter(({ name }) => name === args.scenario) : SCENARIOS;
  if (scenarios.length === 0) {
    throw new Error(`No scenario "${args.scenario}"; known: ${SCENARIOS.map(({ name }) => name).join(', ')}`);
  }
  const box = resolveBox();
  const api = createHomeyApi(box);
  const pels = createPels(api);
  console.log(`SHS suite on ${box.name} (${box.id}), port ${box.port}`);

  if (!args.skipInstall) {
    for (const appId of [TEST_DEVICES_APP_ID, PELS_APP_ID]) {
      for (const { pid, cwd } of await stopRunSessions(box, appId)) {
        console.log(`stopped homey app run ${pid} (${cwd}), which held ${appId} on this box`);
      }
    }
    console.log(`installing test-devices ${commitOf(TEST_DEVICES_DIR)} with --clean`);
    await installClean(box, api, TEST_DEVICES_DIR, TEST_DEVICES_APP_ID);
    // The settings page is generated and untracked, and Homey refuses an app without it.
    execFileSync('npm', ['run', 'build:settings'], { cwd: PELS_DIR, stdio: 'inherit' });
    console.log(`installing PELS ${commitOf(PELS_DIR)} with --clean`);
    await installClean(box, api, PELS_DIR, PELS_APP_ID);
  }

  const failures = [];
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    console.log(`\n▶ ${scenario.name}: ${scenario.summary}`);
    try {
      await scenario.run({ box, api, pels, log: (line) => console.log(`  ${line}`) });
      console.log(`✓ ${scenario.name} (${Math.round((Date.now() - startedAt) / 1000)} s)`);
    } catch (error) {
      failures.push(scenario.name);
      console.log(`✗ ${scenario.name}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${scenarios.length} failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${scenarios.length} passed`);
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
