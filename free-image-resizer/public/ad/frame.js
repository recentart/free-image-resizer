'use strict';

// Runs inside one sandboxed ad frame and writes Adsterra's standard banner snippet for one unit.
(() => {
  const size = new URLSearchParams(location.search).get('unit') || '';
  const code = ((window.ADS && window.ADS.banners) || {})[size] || '';
  const match = /^(?:https?:)?\/\/([a-z0-9.:-]+)\/([a-z0-9]+)\/invoke\.js$/i.exec(code);
  if (!match) return;
  const [width, height] = size.split('x').map(Number);
  window.atOptions = { key: match[2], format: 'iframe', height, width, params: {} };
  // Protocol-relative, exactly like the snippet Adsterra hands out.
  document.write(`<script src="//${match[1]}/${match[2]}/invoke.js"><\/script>`);
})();
