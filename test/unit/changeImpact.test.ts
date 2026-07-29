import { classifyChangeImpact } from '../../scripts/lib/change-impact.mjs';

describe('change impact classifier', () => {
  it('routes shared contracts through runtime and settings UI validation', () => {
    expect(classifyChangeImpact(['packages/contracts/src/device.ts'])).toMatchObject({
      runtime: true,
      settingsUi: true,
      browserRisk: false,
    });
  });

  it('routes shared-package manifests through both consumer test wiring paths', () => {
    for (const file of [
      'packages/contracts/package.json',
      'packages/shared-domain/package.json',
    ]) {
      expect(classifyChangeImpact([file])).toMatchObject({
        runtime: true,
        settingsUi: true,
      });
    }
  });

  it('routes the Playwright static server through UI and browser validation', () => {
    expect(classifyChangeImpact(['packages/settings-ui/scripts/static-server.mjs'])).toMatchObject({
      settingsUi: true,
      browserRisk: true,
    });
  });

  it('routes CSS changes through every browser-risk gate', () => {
    expect(classifyChangeImpact(['packages/settings-ui/public/style.css'])).toMatchObject({
      runtime: false,
      settingsUi: true,
      browserRisk: true,
    });
  });

  it('routes design-token inputs and outputs through UI and browser validation', () => {
    for (const file of [
      'tokens/color.json',
      'packages/settings-ui/style-dictionary.config.mjs',
      'settings/tokens.css',
    ]) {
      expect(classifyChangeImpact([file])).toMatchObject({
        settingsUi: true,
        browserRisk: true,
      });
    }
  });

  it('rebuilds docs when shared workflow infrastructure changes', () => {
    for (const file of [
      '.github/actions/setup/action.yml',
      '.github/workflows/test.yml',
    ]) {
      expect(classifyChangeImpact([file]).docs).toBe(true);
    }
  });

  it('reports changed functional specs but excludes capture harnesses', () => {
    expect(classifyChangeImpact([
      'packages/settings-ui/tests/e2e/settings-smoke.spec.ts',
      'packages/settings-ui/tests/e2e/budget-screenshots.spec.ts',
    ]).e2eSpecs).toEqual(['tests/e2e/settings-smoke.spec.ts']);
  });

  it('forces every test surface for shared test infrastructure', () => {
    expect(classifyChangeImpact(['package-lock.json'])).toMatchObject({
      runtime: true,
      settingsUi: true,
      browserRisk: true,
      docs: true,
      playwrightFull: true,
    });
  });

  it('treats planner contracts and test scripts as runtime changes', () => {
    expect(classifyChangeImpact([
      'packages/planner-types/src/planInputDevice.ts',
      'scripts/pre-push-checks.mjs',
    ]).runtime).toBe(true);
  });

  it('forces every lane for classifier and bounded-runner changes', () => {
    for (const file of [
      'scripts/classify-change-impact.mjs',
      'scripts/lib/change-impact.mjs',
      'scripts/lib/run-parallel.mjs',
    ]) {
      expect(classifyChangeImpact([file])).toMatchObject({
        runtime: true,
        settingsUi: true,
        browserRisk: true,
      });
    }
  });

  it('runs synthetic policy regressions when Stylelint configuration changes', () => {
    expect(classifyChangeImpact(['.stylelintrc.cjs'])).toMatchObject({
      runtime: true,
      settingsUi: true,
      browserRisk: true,
    });
  });
});
