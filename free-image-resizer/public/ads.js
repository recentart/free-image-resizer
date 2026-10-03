/*
 * Small Adsterra banner boxes (codes live in ads-config.js).
 *
 * Each live ad runs in its own sandboxed frame (ad/index.html) with an opaque origin, so ad code
 * can't reach this page, the image being resized or the download. A box stays hidden until a
 * banner code for its size is set.
 */
(() => {
  'use strict';

  const BANNER = /^(?:https?:)?\/\/([a-z0-9.:-]+)\/([a-z0-9]+)\/invoke\.js$/i;
  const banners = (window.ADS && window.ADS.banners) || {};
  const isLive = (size) => BANNER.test(banners[size] || '');

  for (const [size, code] of Object.entries(banners)) {
    if (code && !isLive(size)) console.error(`ads-config.js: the ${size} entry doesn't look like an Adsterra invoke.js address.`);
  }

  const slots = Array.from(document.querySelectorAll('[data-ad-sizes]'));

  function fill(slot) {
    if (slot.dataset.adFilled) return;
    // The slot is hidden until filled, so measure the space around it (minus the 16px gutters).
    const room = Math.min(slot.parentElement.clientWidth, document.documentElement.clientWidth) - 32;
    const sizes = slot.dataset.adSizes.split(' ');
    const size = sizes.find((s) => parseInt(s, 10) <= room) || sizes[sizes.length - 1];
    if (!isLive(size)) return;

    const [width, height] = size.split('x');
    const frame = document.createElement('iframe');
    frame.title = 'Advertisement';
    frame.width = width;
    frame.height = height;
    frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    frame.src = `ad/?unit=${size}`;
    slot.querySelector('.ad-box').append(frame);
    slot.dataset.adFilled = size;
    slot.hidden = false;
  }

  slots.forEach(fill);
  window.addEventListener('resize', () => slots.forEach(fill));
})();
