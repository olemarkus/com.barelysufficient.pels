import { describe, expect, test } from 'vitest';

// Loaded via dynamic import because the source is a plain ESM .mjs script
// outside the TypeScript build graph.
const {
  filterArrayLiteral,
  rewriteSidebarSource,
  matchNestedItems,
  splitArrayEntries,
} = await import('../../scripts/sidebarFilter.mjs');

function pageExistsFor(existing: ReadonlyArray<string>) {
  const set = new Set(existing);
  return (link: string) => Promise.resolve(set.has(link));
}

describe('sidebarFilter.filterArrayLiteral', () => {
  test('keeps section when first nested child is missing but a later child exists', async () => {
    const input = `
      { text: 'Foo', items: [
        { text: 'A', link: '/missing' },
        { text: 'B', link: '/exists' },
      ] }
    `;

    const result = await filterArrayLiteral(input, pageExistsFor(['/exists']));

    expect(result).toContain("link: '/exists'");
    expect(result).not.toContain("/missing");
    expect(result).toContain("text: 'Foo'");
  });

  test('drops section entirely when every nested child is missing', async () => {
    const input = `
      { text: 'Smart Tasks', items: [
        { text: 'A', link: '/missing-a' },
        { text: 'B', link: '/missing-b' },
      ] }
    `;

    const result = await filterArrayLiteral(input, pageExistsFor([]));

    expect(result.trim()).toBe('');
  });

  test('drops leaf entries whose own link points to a missing page', async () => {
    const input = `
      { text: 'A', link: '/exists' },
      { text: 'B', link: '/missing' },
    `;

    const result = await filterArrayLiteral(input, pageExistsFor(['/exists']));

    expect(result).toContain("link: '/exists'");
    expect(result).not.toContain("/missing");
  });

  test('keeps external (non-internal) links regardless of pageExists', async () => {
    const input = `
      { text: 'App Store', link: 'https://example.com/app' }
    `;

    const result = await filterArrayLiteral(input, pageExistsFor([]));

    expect(result).toContain('https://example.com/app');
  });

  test('treats `/` as the index page', async () => {
    const input = `
      { text: 'Overview', link: '/' }
    `;

    const result = await filterArrayLiteral(input, pageExistsFor(['/']));

    expect(result).toContain("link: '/'");
  });
});

describe('sidebarFilter.rewriteSidebarSource', () => {
  test('rewrites both navItems and sidebar exports while preserving file structure', async () => {
    const source = [
      "import type { DefaultTheme } from 'vitepress';",
      '',
      'export const navItems: DefaultTheme.NavItem[] = [',
      "  { text: 'External', link: 'https://example.com' },",
      "  { text: 'Gone', link: '/missing' },",
      "  { text: 'Here', link: '/exists' },",
      '];',
      '',
      'export const sidebar: DefaultTheme.SidebarItem[] = [',
      '  {',
      "    text: 'Section',",
      '    items: [',
      "      { text: 'Gone', link: '/missing' },",
      "      { text: 'Here', link: '/exists' },",
      '    ],',
      '  },',
      '];',
      '',
    ].join('\n');

    const rewritten = await rewriteSidebarSource(source, pageExistsFor(['/exists']));

    expect(rewritten).toContain('https://example.com');
    expect(rewritten).toContain("link: '/exists'");
    expect(rewritten).not.toContain('/missing');
    expect(rewritten).toContain("export const navItems");
    expect(rewritten).toContain("export const sidebar");
  });
});

describe('sidebarFilter.matchNestedItems', () => {
  test('returns the inner literal for a section with nested items', () => {
    const entry = "{ text: 'Foo', items: [ { text: 'A', link: '/a' } ] }";
    const result = matchNestedItems(entry);

    expect(result).not.toBeNull();
    expect(result!.inner).toContain("link: '/a'");
  });

  test('returns null when the entry has no items key', () => {
    const entry = "{ text: 'Leaf', link: '/x' }";
    expect(matchNestedItems(entry)).toBeNull();
  });
});

describe('sidebarFilter.splitArrayEntries', () => {
  test('splits on top-level commas only, preserving nested commas', () => {
    const input = "{ a: 1, b: [1, 2, 3] }, { c: 2 }";
    const parts = splitArrayEntries(input);

    expect(parts.length).toBe(2);
    expect(parts[0]).toContain('[1, 2, 3]');
    expect(parts[1]).toContain('c: 2');
  });
});
