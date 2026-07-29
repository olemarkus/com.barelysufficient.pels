import fs from 'node:fs';
import path from 'node:path';
import stylelint from 'stylelint';

const filename = path.resolve(
  __dirname,
  '../../packages/settings-ui/public/token-lint-fixture.css',
);
const componentTokensPath = path.resolve(__dirname, '../../tokens/component.json');

const warningsFor = async (code: string) => {
  const result = await stylelint.lint({ code, codeFilename: filename });
  return result.results[0]?.warnings ?? [];
};

describe('Settings UI token lint', () => {
  it('defines the pulse duration in the token source', () => {
    const tokens: unknown = JSON.parse(fs.readFileSync(componentTokensPath, 'utf8'));

    expect(tokens).toMatchObject({
      pels: {
        motion: {
          'pulse-duration': { value: '1.5s' },
        },
      },
    });
  });

  it('rejects bindable geometry, typography, and pulse-duration literals', async () => {
    const warnings = await warningsFor(`
      .fixture {
        gap: 12px;
        border-radius: 999px;
        font-size: 0.75rem;
        animation: plan-chip-building-pulse 1.5s ease-in-out infinite;
      }
    `);

    expect(warnings).toHaveLength(4);
  });

  it('accepts the corresponding design tokens', async () => {
    const warnings = await warningsFor(`
      .fixture {
        gap: var(--spacing-3);
        border-radius: var(--radius-full);
        font-size: var(--font-size-sm);
        animation: pulse var(--pels-motion-pulse-duration) ease-in-out infinite;
      }
    `);

    expect(warnings).toEqual([]);
  });
});
