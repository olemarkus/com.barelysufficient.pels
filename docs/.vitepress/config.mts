import { defineConfig, type HeadConfig } from 'vitepress';

const siteUrl = 'https://pels.barelysufficient.com';
const defaultDescription =
  'Homey Pro app for capacity control, price-aware load shifting, and Flow-friendly energy control.';

function resolvePageUrl(relativePath: string): string {
  const htmlPath = relativePath
    .replace(/^index\.md$/, 'index.html')
    .replace(/\/index\.md$/, '/index.html')
    .replace(/\.md$/, '.html');

  if (htmlPath === 'index.html') {
    return `${siteUrl}/`;
  }

  return `${siteUrl}/${htmlPath}`;
}

function propertyMeta(property: string, content: string): HeadConfig {
  return ['meta', { property, content }];
}

function namedMeta(name: string, content: string): HeadConfig {
  return ['meta', { name, content }];
}

export default defineConfig({
  srcExclude: ['images/README.md'],
  base: '/',
  lang: 'en-US',
  title: 'PELS',
  description: defaultDescription,
  appearance: false,
  lastUpdated: true,
  sitemap: {
    hostname: siteUrl,
  },
  head: [
    ['link', { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#eef6f2' }],
  ],
  themeConfig: {
    logo: '/icon.svg',
    siteTitle: 'PELS',
    nav: [
      { text: 'App Store', link: 'https://homey.app/a/com.barelysufficient.pels' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Configuration', link: '/configuration' },
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
          { text: 'Tips and Best Practices', link: '/tips-and-best-practices' },
        ],
      },
      {
        text: 'Advanced Usage',
        items: [
          {
            text: 'Wire a Stepped Load Device',
            link: '/how-to-headroom-expected-power-flow-control',
          },
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
        'https://github.com/olemarkus/com.barelysufficient.pels/edit/main/docs/:path',
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
    const imageUrl = `${siteUrl}/social-card.png`;

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
