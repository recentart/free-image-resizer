/*
 * Google AdSense for the two small ad boxes in index.html.
 *
 * Fill in both IDs to switch the ads on. While either is empty, the boxes stay
 * hidden and no ad code is loaded. Also put your publisher ID in ads.txt.
 */
(() => {
  'use strict';

  const ADSENSE = {
    client: '', // publisher ID, e.g. 'ca-pub-1234567890123456'
    slot: '', // display ad unit ID (AdSense → Ads → By ad unit), e.g. '1234567890'
  };

  if (!/^ca-pub-\d{10,20}$/.test(ADSENSE.client) || !/^\d{5,20}$/.test(ADSENSE.slot)) return;

  const units = Array.from(document.querySelectorAll('ins.adsbygoogle'));
  const showBoxes = (show) => {
    for (const ins of units) ins.closest('.ad-slot').hidden = !show;
  };

  for (const ins of units) {
    ins.dataset.adClient = ADSENSE.client;
    ins.dataset.adSlot = ADSENSE.slot;
  }
  showBoxes(true);

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE.client}`;
  script.onerror = () => showBoxes(false); // blocked by an ad blocker or offline
  document.head.append(script);

  for (let i = 0; i < units.length; i++) (window.adsbygoogle = window.adsbygoogle || []).push({});
})();
