import type { DefaultTheme } from 'vitepress';

export const navItems: DefaultTheme.NavItem[] = [
  { text: 'App Store', link: 'https://homey.app/a/com.barelysufficient.pels' },
  { text: 'Getting Started', link: '/getting-started' },
  { text: 'Use Cases', link: '/#start-by-problem' },
  { text: 'Configuration', link: '/configuration' },
  { text: 'Flow Cards', link: '/flow-cards' },
];

export const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Start Here',
    items: [
      { text: 'Overview', link: '/' },
      { text: 'For norske hjem', link: '/stromstyring-norge' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Flow Cards', link: '/flow-cards' },
      { text: 'PELS Insights', link: '/insights-device' },
      { text: 'Dashboard Widgets', link: '/widgets' },
      { text: 'Using Homey Energy', link: '/homey-energy' },
      { text: 'Tips and Best Practices', link: '/tips-and-best-practices' },
    ],
  },
  {
    text: 'Use Cases',
    items: [
      { text: 'EV charging under a power limit', link: '/use-cases/homey-ev-charging-power-limit' },
      {
        text: 'Hot water and heating in cheap hours',
        link: '/use-cases/homey-water-heater-cheap-hours',
      },
      {
        text: 'Home, Away and Night energy modes',
        link: '/use-cases/homey-home-away-night-energy-modes',
      },
    ],
  },
  {
    text: 'Cost & Scheduling',
    items: [
      { text: 'Compare Cost-Saving Functions', link: '/cost-saving-functions' },
      { text: 'Daily Energy Budget', link: '/daily-budget' },
      { text: 'Smart Tasks', link: '/smart-tasks' },
      { text: 'Book Cheap Hours With Flows', link: '/how-to-book-cheap-hours-with-flows' },
      { text: 'Price Tags in Flow & HomeyScript', link: '/price-tags' },
    ],
  },
  {
    text: 'Device Integrations',
    items: [
      {
        text: 'Wire a Flow-Based Load Device',
        link: '/how-to-headroom-expected-power-flow-control',
      },
      { text: 'Configure an EV Charger', link: '/ev-charger' },
      { text: 'Configure a Zaptec EV Charger', link: '/zaptec-ev-charger' },
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
];
