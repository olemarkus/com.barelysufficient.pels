import { h } from 'vue';
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import './custom.css';

// Names the part of the site a page belongs to (User guide, Developer docs)
// next to the site name; the config sets `siteSection` on every page and
// leaves it empty on the landing pages.
const SiteSection = {
  setup() {
    const { frontmatter } = useData();
    return () => (frontmatter.value.siteSection
      ? h('span', { class: 'site-section' }, frontmatter.value.siteSection)
      : null);
  },
};

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-title-after': () => h(SiteSection),
  }),
};
