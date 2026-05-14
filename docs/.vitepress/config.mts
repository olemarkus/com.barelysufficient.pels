import { defineConfig, type DefaultTheme, type HeadConfig } from 'vitepress';

const defaultSiteUrl = 'https://pels.barelysufficient.org';
const defaultDescription =
  'Homey Pro app for capacity control, price-aware load shifting, and Flow-friendly energy control.';
const channelLabels = {
  live: 'Live',
  test: 'Test',
  dev: 'Dev',
} as const;

type DocsChannel = keyof typeof channelLabels;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeBase(value: string | undefined): string {
  if (!value || value === '/') return '/';

  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function normalizeSiteUrl(value: string | undefined): string {
  return (value ?? defaultSiteUrl).replace(/\/+$/, '');
}

function resolveChannel(value: string | undefined): DocsChannel {
  return value === 'test' || value === 'dev' ? value : 'live';
}

function displayRef(value: string | undefined): string {
  if (!value) return '';

  const normalized = value
    .replace(/^refs\/tags\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');

  return /^[\da-f]{40}$/i.test(normalized) ? normalized.slice(0, 7) : normalized;
}

const base = normalizeBase(readEnv('PELS_DOCS_BASE'));
const siteUrl = normalizeSiteUrl(readEnv('PELS_DOCS_SITE_URL'));
const docsChannel = resolveChannel(readEnv('PELS_DOCS_CHANNEL'));
const channelRefs: Record<DocsChannel, string | undefined> = {
  live: readEnv('PELS_DOCS_LIVE_REF'),
  test: readEnv('PELS_DOCS_TEST_REF'),
  dev: readEnv('PELS_DOCS_DEV_REF') ?? 'main',
};
const editRef = readEnv('PELS_DOCS_EDIT_REF') ?? 'main';
const outDir = readEnv('PELS_DOCS_OUT_DIR');

function withBase(relativePath: string): string {
  const cleanPath = relativePath.replace(/^\/+/, '');

  if (base === '/') {
    return cleanPath.length > 0 ? `/${cleanPath}` : '/';
  }

  return `${base}${cleanPath}`;
}

function channelText(channel: DocsChannel): string {
  const ref = displayRef(channelRefs[channel]);
  return ref ? `${channelLabels[channel]} ${ref}` : channelLabels[channel];
}

function channelUrl(channel: DocsChannel): string {
  const channelBase: Record<DocsChannel, string> = {
    live: '/',
    test: '/test/',
    dev: '/dev/',
  };

  return `${siteUrl}${channelBase[channel]}`;
}

const channelSwitcher: DefaultTheme.NavItemWithChildren = {
  text: `Docs: ${channelText(docsChannel)}`,
  items: [
    { text: channelText('live'), link: channelUrl('live'), target: '_self' },
    { text: channelText('test'), link: channelUrl('test'), target: '_self' },
    { text: channelText('dev'), link: channelUrl('dev'), target: '_self' },
  ],
};

function resolvePageUrl(relativePath: string): string {
  const htmlPath = relativePath
    .replace(/^index\.md$/, 'index.html')
    .replace(/\/index\.md$/, '/index.html')
    .replace(/\.md$/, '.html');

  const pagePath = htmlPath === 'index.html' ? '' : htmlPath;
  return `${siteUrl}${withBase(pagePath)}`;
}

function propertyMeta(property: string, content: string): HeadConfig {
  return ['meta', { property, content }];
}

function namedMeta(name: string, content: string): HeadConfig {
  return ['meta', { name, content }];
}

export default defineConfig({
  srcExclude: ['images/README.md'],
  ...(outDir ? { outDir } : {}),
  base,
  lang: 'en-US',
  title: 'PELS',
  description: defaultDescription,
  appearance: false,
  lastUpdated: true,
  sitemap: {
    hostname: siteUrl,
  },
  head: [
    ['link', { rel: 'icon', href: withBase('icon.svg'), type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#eef6f2' }],
    ...(docsChannel === 'live' ? [] : [namedMeta('robots', 'noindex, nofollow')]),
    ...(docsChannel === 'live' ? [[
      'script',
      {
        defer: 'defer',
        'data-cf-beacon': '{"token": "81524baa929d44238fcf2afd37134c4a"}',
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
      },
    ] as HeadConfig] : []),
  ],
  themeConfig: {
    logo: '/icon.svg',
    siteTitle: 'PELS',
    nav: [
      { text: 'App Store', link: 'https://homey.app/a/com.barelysufficient.pels' },
      channelSwitcher,
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Smart Tasks', link: '/smart-tasks' },
      { text: 'Flow Cards', link: '/flow-cards' },
    ],
    search: {
      provider: 'local',
    },
    sidebar: [
      {
        text: 'Start Here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Flow Cards', link: '/flow-cards' },
          { text: 'PELS Insights', link: '/insights-device' },
          { text: 'Using Homey Energy', link: '/homey-energy' },
          { text: 'Tips and Best Practices', link: '/tips-and-best-practices' },
        ],
      },
      {
        text: 'Smart Tasks',
        items: [
          { text: 'Compare Cost-Saving Functions', link: '/cost-saving-functions' },
          { text: 'Smart Tasks', link: '/smart-tasks' },
          { text: 'Book Cheap Hours With Flows', link: '/how-to-book-cheap-hours-with-flows' },
        ],
      },
      {
        text: 'Advanced Usage',
        items: [
          {
            text: 'Wire a Flow-Based Load Device',
            link: '/how-to-headroom-expected-power-flow-control',
          },
          { text: 'Configure an EV Charger', link: '/ev-charger' },
          { text: 'Configure a Zaptec EV Charger', link: '/zaptec-ev-charger' },
          { text: 'Daily Energy Budget', link: '/daily-budget' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Technical Reference', link: '/technical' },
          { text: 'Plan States', link: '/plan-states' },
          { text: 'Daily Budget Weighting', link: '/daily-budget-weights' },
          { text: 'Architecture Contract', link: '/architecture' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Contributor Setup', link: '/contributor-setup' },
        ],
      },
    ],
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/olemarkus/com.barelysufficient.pels',
      },
    ],
    editLink: {
      pattern:
        `https://github.com/olemarkus/com.barelysufficient.pels/edit/${editRef}/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Built for Homey Pro users who need tighter control over large loads.',
      copyright: 'Copyright (c) Ole Markus With',
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    lastUpdated: {
      text: 'Updated',
    },
    docFooter: {
      prev: 'Previous page',
      next: 'Next page',
    },
  },
  transformHead({ pageData, title, description }) {
    const pageUrl = resolvePageUrl(pageData.relativePath);
    const pageTitle = title || 'PELS';
    const pageDescription = description || defaultDescription;
    const imageUrl = `${siteUrl}${withBase('social-card.png')}`;

    return [
      ['link', { rel: 'canonical', href: pageUrl }],
      propertyMeta(
        'og:type',
        pageData.relativePath === 'index.md' ? 'website' : 'article',
      ),
      propertyMeta('og:site_name', 'PELS'),
      propertyMeta('og:url', pageUrl),
      propertyMeta('og:title', pageTitle),
      propertyMeta('og:description', pageDescription),
      propertyMeta('og:image', imageUrl),
      namedMeta('twitter:card', 'summary_large_image'),
      namedMeta('twitter:title', pageTitle),
      namedMeta('twitter:description', pageDescription),
      namedMeta('twitter:image', imageUrl),
    ];
  },
});
