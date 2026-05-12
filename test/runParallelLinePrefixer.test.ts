import { describe, expect, it } from 'vitest';
import { createLinePrefixer } from '../scripts/lib/run-parallel.mjs';

const collect = (): { write: (line: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), lines };
};

describe('createLinePrefixer', () => {
  it('emits each complete line with the label prefix', () => {
    const sink = collect();
    const prefixer = createLinePrefixer('tag', sink.write);
    prefixer.push('first\nsecond\n');
    expect(sink.lines).toEqual(['[tag] first\n', '[tag] second\n']);
  });

  it('preserves empty lines from the underlying stream', () => {
    const sink = collect();
    const prefixer = createLinePrefixer('tag', sink.write);
    prefixer.push('one\n\nthree\n');
    expect(sink.lines).toEqual(['[tag] one\n', '[tag] \n', '[tag] three\n']);
  });

  it('joins fragments that cross chunk boundaries before prefixing', () => {
    const sink = collect();
    const prefixer = createLinePrefixer('tag', sink.write);
    prefixer.push('Error: ');
    prefixer.push('message\n');
    expect(sink.lines).toEqual(['[tag] Error: message\n']);
  });

  it('flushes a trailing partial line without an injected newline gap', () => {
    const sink = collect();
    const prefixer = createLinePrefixer('tag', sink.write);
    prefixer.push('partial');
    expect(sink.lines).toEqual([]);
    prefixer.flush();
    expect(sink.lines).toEqual(['[tag] partial\n']);
  });

  it('flush is a no-op when the buffer is already drained', () => {
    const sink = collect();
    const prefixer = createLinePrefixer('tag', sink.write);
    prefixer.push('done\n');
    prefixer.flush();
    expect(sink.lines).toEqual(['[tag] done\n']);
  });
});
