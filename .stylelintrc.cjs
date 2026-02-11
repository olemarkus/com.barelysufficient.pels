module.exports = {
  extends: ['stylelint-config-recommended'],
  rules: {
    'selector-max-specificity': '1,4,1',
    'selector-class-pattern': '^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:__(?:[a-z0-9]+(?:-[a-z0-9]+)*))?(?:--(?:[a-z0-9]+(?:-[a-z0-9]+)*))?$',
    'custom-property-pattern': '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
    'keyframes-name-pattern': '^[a-z][a-z0-9-]*$',
    'declaration-block-no-shorthand-property-overrides': true,
    'declaration-block-no-redundant-longhand-properties': true,
  },
};
