// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The smart-task creation flow (`widgets/_shared/smartTaskCreate`) renders into
// markup each hosting widget carries in its own index.html. The copies must be
// identical, or the shared controller would bind to different elements in the
// two widgets.
const section = (path: string, name: string): string => {
  const html = readFileSync(path, 'utf8');
  const start = html.indexOf(`<!-- ${name}:start`);
  const end = html.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) throw new Error(`${path} has no ${name} section`);
  return html.slice(start, end);
};

describe('smart-task creation flow markup', () => {
  it.each(['smart-task-create-flow', 'smart-task-create-template'])('%s is identical in every hosting widget', (name) => {
    expect(section('widgets/device/public/index.html', name))
      .toBe(section('widgets/create_smart_task/public/index.html', name));
  });
});
