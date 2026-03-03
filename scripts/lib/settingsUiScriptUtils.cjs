const readOptionValue = (argv, index, option, valueHint = '') => {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`Missing value for ${option}${valueHint}`);
  }
  return next;
};

const stripScriptElements = (html) => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html);
  dom.window.document.querySelectorAll('script').forEach((element) => element.remove());
  const sanitized = dom.serialize();
  dom.window.close();
  return sanitized;
};

module.exports = {
  readOptionValue,
  stripScriptElements,
};
