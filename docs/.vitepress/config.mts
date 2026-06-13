import { defineConfig, type DefaultTheme, type HeadConfig } from 'vitepress';
import { navItems, sidebar } from './sidebar.mts';

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

function jsonLdScript(data: Record<string, unknown>): HeadConfig {
  return ['script', { type: 'application/ld+json' }, JSON.stringify(data)];
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
    ['meta', { name: 'theme-color', content: '#f6f7fb' }],
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
      navItems[0],
      channelSwitcher,
      ...navItems.slice(1),
    ],
    search: {
      provider: 'local',
    },
    sidebar,
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
    const imageAlt =
      'PELS — automatic power-limit control and cheap-hour load shifting for Homey Pro';
    const isNorwegian = pageData.relativePath === 'stromstyring-norge.md';
    const ogLocale = isNorwegian ? 'nb_NO' : 'en_US';
    // Only declare an alternate locale where a cross-language counterpart
    // actually exists: the English homepage and the Norwegian overview point at
    // each other. No other page has a translated alternate, so it gets none.
    const alternateLocaleByPage: Record<string, string> = {
      'index.md': 'nb_NO',
      'stromstyring-norge.md': 'en_US',
    };
    const ogLocaleAlternate = alternateLocaleByPage[pageData.relativePath];

    return [
      ['link', { rel: 'canonical', href: pageUrl }],
      propertyMeta(
        'og:type',
        pageData.relativePath === 'index.md' ? 'website' : 'article',
      ),
      propertyMeta('og:site_name', 'PELS'),
      propertyMeta('og:locale', ogLocale),
      ...(ogLocaleAlternate
        ? [propertyMeta('og:locale:alternate', ogLocaleAlternate)]
        : []),
      propertyMeta('og:url', pageUrl),
      propertyMeta('og:title', pageTitle),
      propertyMeta('og:description', pageDescription),
      propertyMeta('og:image', imageUrl),
      propertyMeta('og:image:width', '1000'),
      propertyMeta('og:image:height', '700'),
      propertyMeta('og:image:alt', imageAlt),
      namedMeta('twitter:card', 'summary_large_image'),
      namedMeta('twitter:title', pageTitle),
      namedMeta('twitter:description', pageDescription),
      namedMeta('twitter:image', imageUrl),
      namedMeta('twitter:image:alt', imageAlt),
      // SoftwareApplication entity markup belongs on one canonical page (the
      // homepage), not repeated on every doc page — so it is built only here.
      // Fields are kept to what we can state truthfully: no price/rating is
      // asserted, so the store link is carried by installUrl + sameAs rather
      // than a fabricated Offer.
      ...(pageData.relativePath === 'index.md'
        ? [
            jsonLdScript({
              '@context': 'https://schema.org',
              '@type': 'SoftwareApplication',
              name: 'PELS',
              applicationCategory: 'UtilitiesApplication',
              operatingSystem: 'Homey Pro',
              description: defaultDescription,
              url: siteUrl,
              image: imageUrl,
              installUrl: 'https://homey.app/a/com.barelysufficient.pels',
              softwareHelp: siteUrl,
              inLanguage: 'en',
              author: { '@type': 'Person', name: 'Ole Markus With' },
              sameAs: [
                'https://homey.app/a/com.barelysufficient.pels',
                'https://github.com/olemarkus/com.barelysufficient.pels',
              ],
            }),
          ]
        : []),
    ];
  },
  transformHtml(code, id) {
    // VitePress hardcodes <html lang> to the site lang (en-US). The Norwegian
    // overview is written entirely in Norwegian, so correct its lang attribute
    // for that one page instead of standing up a parallel i18n locale tree.
    if (id.endsWith('stromstyring-norge.html')) {
      return code.replace('<html lang="en-US"', '<html lang="nb-NO"');
    }
    return code;
  },
});
