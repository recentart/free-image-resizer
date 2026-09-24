/*
 * Browser tests for Free Image Resizer. They drive the real page in an iframe
 * through its UI, then fetch the download link's blob and decode it to check
 * the file that would actually be saved.
 */
(async () => {
  'use strict';

  if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
  const frame = document.getElementById('app-frame');
  const win = frame.contentWindow;
  const doc = win.document;
  const $ = (id) => doc.getElementById(id);
  const rows = document.getElementById('rows');
  const results = [];

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class Skip extends Error {}
  // Re-checks on every DOM change in the app instead of polling, because
  // browsers throttle timers in hidden tabs to as little as once a minute.
  function waitFor(fn, what, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeout);
      function check() {
        const value = fn();
        if (!value) return false;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
        return true;
      }
      if (!check()) observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }
  const shown = (el) => !!el && !el.closest('[hidden]');
  const text = (id) => $(id).textContent.trim();
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  function eq(actual, expected, what) {
    if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  function paint(w, h, { alpha = false, split = false } = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (split) {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, w / 2, h);
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(w / 2, 0, w / 2, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#e63946');
      g.addColorStop(0.5, '#f1fa8c');
      g.addColorStop(1, '#1d3557');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      let seed = 7; // deterministic noise so encoders have detail to compress
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const n = Math.min(4000, (w * h) / 150);
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = `hsl(${rnd() * 360},70%,${30 + rnd() * 40}%)`;
        ctx.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 2 + rnd() * 6);
      }
    }
    if (alpha) ctx.clearRect(0, 0, Math.floor(w / 2), h);
    return c;
  }
  async function makeFile(name, mime, w, h, opts) {
    const blob = await new Promise((r) => paint(w, h, opts).toBlob(r, mime, 0.92));
    assert(blob && blob.type === mime, `this browser can't encode ${mime} test images`);
    return new win.File([blob], name, { type: mime });
  }
  const rawFile = (name, mime, bytes) => new win.File([bytes], name, { type: mime });

  function pngHeader(w, h, extra = 0) {
    const b = new Uint8Array(33 + extra);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, w);
    dv.setUint32(20, h);
    b.set([8, 6, 0, 0, 0], 24);
    for (let i = 33; i < b.length; i++) b[i] = (i * 73) & 0xff; // garbage instead of real image data
    return b;
  }

  // A JPEG whose pixels are stored sideways with EXIF orientation 6 (rotate 90° clockwise).
  async function exifJpeg(name) {
    const blob = await new Promise((r) => paint(400, 200, { split: true }).toBlob(r, 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let rest = bytes.subarray(2);
    if (rest[0] === 0xff && rest[1] === 0xe0) rest = rest.subarray(2 + ((rest[2] << 8) | rest[3])); // drop JFIF
    const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = payload.length + 2;
    const head = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
    return new win.File([head, rest], name, { type: 'image/jpeg' });
  }

  const busy = () => $('app').getAttribute('aria-busy') === 'true';
  async function load(file) {
    const dt = new win.DataTransfer();
    dt.items.add(file);
    const input = $('file-input');
    input.files = dt.files;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await waitFor(() => !busy(), 'load to finish');
    return shown($('load-error')) ? text('load-error') : null;
  }
  async function fresh(file) {
    if (shown($('workspace'))) $('clear-btn').click();
    const err = await load(file);
    if (err) throw new Error(`load failed: ${err}`);
  }
  function type(id, value) {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  function choose(value) {
    const el = $('format');
    el.value = value;
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  function setLock(on) {
    if ($('lock').checked !== on) $('lock').click();
  }
  const preset = (p) => doc.querySelector(`[data-scale="${p}"]`).click();
  function setQuality(v) {
    const el = $('quality');
    el.value = String(v);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  async function resize() {
    $('resize-btn').click();
    await waitFor(() => !busy(), 'resize to finish');
    return shown($('resize-error')) ? text('resize-error') : null;
  }
  function sniff(b) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'webp';
    return 'unknown';
  }
  // Fetches and decodes exactly what the Download button would save.
  async function downloaded() {
    const a = $('download');
    assert(shown(a) && a.href.startsWith('blob:'), 'download link is not ready');
    const blob = await (await fetch(a.href)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bitmap = await createImageBitmap(blob);
    return { name: a.getAttribute('download'), magic: sniff(bytes), size: blob.size, w: bitmap.width, h: bitmap.height, bitmap };
  }
  async function resizeOk() {
    const err = await resize();
    if (err) throw new Error(`resize failed: ${err}`);
    return downloaded();
  }
  function expectFile(d, w, h, magic, name) {
    eq(`${d.w}x${d.h}`, `${w}x${h}`, 'downloaded image size');
    eq(d.magic, magic, 'downloaded file format');
    if (name) eq(d.name, name, 'download file name');
    eq(text('res-dims'), `${w.toLocaleString('en-US')} × ${h.toLocaleString('en-US')} px`, 'shown result dimensions');
  }
  function pixel(bitmap, x, y) {
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(x, y, 1, 1).data);
  }

  async function test(name, fn) {
    let ok = false;
    let skipped = false;
    let detail = '';
    try {
      detail = (await fn()) || '';
      ok = true;
    } catch (err) {
      skipped = err instanceof Skip;
      detail = err && err.message ? err.message : String(err);
    }
    results.push({ name, ok, skipped, detail });
    const label = ok ? 'PASS' : skipped ? 'SKIP' : 'FAIL';
    const tr = document.createElement('tr');
    for (const [value, cls] of [[results.length], [name], [label, ok ? 'pass' : skipped ? '' : 'fail'], [detail]]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      if (cls) td.className = cls;
      tr.append(td);
    }
    rows.append(tr);
  }

  // ---------- tests ----------

  await test('Privacy: the page cannot make network requests', async () => {
    let blocked = false;
    try {
      await win.fetch('../public/robots.txt');
    } catch (_) {
      blocked = true;
    }
    assert(blocked, 'fetch() from the app page was not blocked');
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    assert(/connect-src 'none'/.test(csp), 'CSP lacks connect-src none');
    assert(text('page-title') === 'Free Image Resizer', 'title');
    assert(/Your image is resized locally in your browser\. Your image is not uploaded to our server\./.test(doc.body.textContent), 'privacy statement');
    return 'fetch() rejected by CSP';
  });

  await test('JPG: width-only resize, aspect ratio locked, original format', async () => {
    await fresh(await makeFile('holiday photo.jpg', 'image/jpeg', 1200, 800));
    eq(text('orig-format'), 'JPG', 'original format');
    eq(text('orig-dims'), '1,200 × 800 px', 'original dimensions');
    assert(/KB|bytes/.test(text('orig-size')), 'original file size shown');
    eq($('format-original').textContent, 'Original format (JPG)', 'original option label');
    assert($('lock').checked, 'lock is on by default');
    type('width', '600');
    eq($('height').value, '400', 'auto height');
    eq(text('summary-dims'), '600 × 400 px', 'summary before resize');
    const d = await resizeOk();
    expectFile(d, 600, 400, 'jpeg', 'holiday photo-resized.jpg');
    return `600×400 JPG, ${d.size} bytes, “${text('res-change')}”`;
  });

  await test('PNG: height-only resize, aspect ratio locked', async () => {
    await fresh(await makeFile('graphic.png', 'image/png', 1000, 750));
    type('height', '300');
    eq($('width').value, '400', 'auto width');
    const d = await resizeOk();
    expectFile(d, 400, 300, 'png', 'graphic-resized.png');
    return '400×300 PNG';
  });

  await test('WebP: 50% preset, original format kept', async () => {
    await fresh(await makeFile('banner.webp', 'image/webp', 800, 600));
    eq(text('orig-format'), 'WebP', 'original format');
    preset(50);
    eq(`${$('width').value}x${$('height').value}`, '400x300', 'preset fields');
    eq(doc.querySelector('[data-scale="50"]').getAttribute('aria-pressed'), 'true', '50% marked active');
    const d = await resizeOk();
    expectFile(d, 400, 300, 'webp', 'banner-resized.webp');
    return '400×300 WebP';
  });

  await test('Locked ratio rounds correctly (1000×750 → width 333)', async () => {
    await fresh(await makeFile('round.png', 'image/png', 1000, 750));
    type('width', '333');
    eq($('height').value, '250', 'height for 333');
    type('height', '101');
    eq($('width').value, '135', 'width for 101');
    const d = await resizeOk();
    expectFile(d, 135, 101, 'png');
    return '333→250, 101→135';
  });

  await test('Unlocked: custom width + height stretches on purpose', async () => {
    await fresh(await makeFile('stretch.jpg', 'image/jpeg', 1200, 800));
    setLock(false);
    type('width', '300');
    eq($('height').value, '800', 'height untouched while unlocked');
    type('height', '300');
    assert(shown($('summary-warning')) && /stretched/.test(text('summary-warning')), 'stretch warning shown');
    const d = await resizeOk();
    expectFile(d, 300, 300, 'jpeg');
    setLock(true);
    eq($('width').value, '450', 're-locking recalculates from the last edited side');
    return '300×300; re-lock → 450×300';
  });

  await test('Presets 25/50/75/100% (odd 1001×667 source)', async () => {
    await fresh(await makeFile('odd.png', 'image/png', 1001, 667));
    const scales = Array.from(doc.querySelectorAll('[data-scale]')).map((b) => Number(b.dataset.scale));
    eq(scales.join(','), '25,50,75,100', 'available presets (none above 100%)');
    const expected = { 25: [250, 167], 50: [501, 334], 75: [751, 500], 100: [1001, 667] };
    const out = [];
    for (const p of scales) {
      preset(p);
      const [w, h] = expected[p];
      eq(`${$('width').value}x${$('height').value}`, `${w}x${h}`, `${p}% fields`);
      const d = await resizeOk();
      expectFile(d, w, h, 'png');
      out.push(`${p}%→${w}×${h}`);
    }
    return out.join(', ');
  });

  await test('Output formats: PNG source → JPG, PNG, WebP', async () => {
    await fresh(await makeFile('convert.png', 'image/png', 640, 480));
    const out = [];
    for (const [value, magic, ext] of [['jpeg', 'jpeg', 'jpg'], ['png', 'png', 'png'], ['webp', 'webp', 'webp']]) {
      choose(value);
      preset(50);
      const d = await resizeOk();
      expectFile(d, 320, 240, magic, `convert-resized.${ext}`);
      eq(text('res-format'), { jpeg: 'JPG', png: 'PNG', webp: 'WebP' }[value], 'shown result format');
      out.push(`${ext} ${d.size}B`);
    }
    return out.join(', ');
  });

  await test('Transparent PNG keeps transparency as PNG and WebP', async () => {
    await fresh(await makeFile('logo.png', 'image/png', 400, 200, { alpha: true }));
    for (const value of ['png', 'webp']) {
      choose(value);
      assert(!shown($('alpha-warning')), `no JPG warning for ${value}`);
      const d = await resizeOk();
      expectFile(d, 400, 200, value);
      eq(pixel(d.bitmap, 20, 100)[3], 0, `${value}: transparent pixel alpha`);
      eq(pixel(d.bitmap, 380, 100)[3], 255, `${value}: opaque pixel alpha`);
    }
    return 'alpha 0 kept in PNG and WebP';
  });

  await test('Transparent PNG → JPG warns and fills white', async () => {
    await fresh(await makeFile('logo2.png', 'image/png', 400, 200, { alpha: true }));
    choose('jpeg');
    assert(shown($('alpha-warning')) && /transparen/i.test(text('alpha-warning')), 'transparency warning shown');
    const d = await resizeOk();
    expectFile(d, 400, 200, 'jpeg', 'logo2-resized.jpg');
    const [r, g, b] = pixel(d.bitmap, 20, 100);
    assert(r > 245 && g > 245 && b > 245, `transparent area should be white, got ${r},${g},${b}`);
    return `transparent area → rgb(${r},${g},${b})`;
  });

  await test('JPG/WebP quality changes file size; PNG has no quality control', async () => {
    await fresh(await makeFile('quality.jpg', 'image/jpeg', 1200, 800));
    eq($('quality').value, '85', 'default quality');
    eq(text('quality-value'), '85%', 'quality label');
    const out = [];
    for (const value of ['jpeg', 'webp']) {
      choose(value);
      assert(shown($('quality-field')), `quality shown for ${value}`);
      setQuality(30);
      const low = (await resizeOk()).size;
      setQuality(95);
      const high = (await resizeOk()).size;
      assert(low < high, `${value}: q30 (${low}) should be smaller than q95 (${high})`);
      out.push(`${value} q30=${low}B q95=${high}B`);
    }
    choose('png');
    assert(!shown($('quality-field')), 'quality hidden for PNG');
    assert(/no quality setting/.test(text('format-note')), 'PNG note shown');
    setQuality(85);
    return out.join('; ');
  });

  await test('Invalid dimensions are rejected with clear messages', async () => {
    await fresh(await makeFile('invalid.png', 'image/png', 800, 600));
    const cases = [
      ['', /Enter a width/],
      ['0', /at least 1 pixel/],
      ['-5', /at least 1 pixel/],
      ['abc', /must be a number/],
      ['12.5', /whole number/],
      ['20000', /can't be more than 16,384/],
    ];
    for (const [value, pattern] of cases) {
      type('width', value);
      assert(shown($('width-error')) && pattern.test(text('width-error')), `width “${value}”: got “${text('width-error')}”`);
      eq($('width').getAttribute('aria-invalid'), 'true', `aria-invalid for “${value}”`);
      const err = await resize();
      assert(err && /fix the size/.test(err), `resize must be blocked for “${value}”`);
      assert(!shown($('download')), `no download for “${value}”`);
    }
    type('width', '400');
    assert(!shown($('width-error')), 'error clears once valid');
    eq($('height').value, '300', 'valid width syncs height again');
    return `${cases.length} bad values blocked`;
  });

  await test('Oversized output is refused (area and side limits)', async () => {
    await fresh(await makeFile('area.png', 'image/png', 800, 600));
    setLock(false);
    type('width', '16000');
    type('height', '16000');
    assert(shown($('dims-error')) && /megapixels/.test(text('dims-error')), 'area error shown');
    const err = await resize();
    assert(err, 'resize blocked for 256 MP');
    type('height', '20000');
    assert(/16,384/.test(text('height-error')), 'side limit on height');
    setLock(true);
    return text('dims-error') || '256 MP and 20,000 px refused';
  });

  await test('Unsupported files are refused and the current image is kept', async () => {
    await fresh(await makeFile('keep.png', 'image/png', 300, 200));
    for (const file of [
      rawFile('notes.txt', 'text/plain', new TextEncoder().encode('hello')),
      rawFile('anim.gif', 'image/gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0])),
    ]) {
      const err = await load(file);
      assert(err && /isn't a supported file type/.test(err), `${file.name}: got “${err}”`);
    }
    assert(shown($('workspace')) && text('orig-name') === 'keep.png', 'previous image still loaded');
    return 'txt and gif refused';
  });

  await test('Corrupt images show a readable error', async () => {
    if (shown($('workspace'))) $('clear-btn').click();
    const files = [
      rawFile('broken.png', 'image/png', pngHeader(100, 100, 200)),
      rawFile('fake.jpg', 'image/jpeg', new TextEncoder().encode('this is not an image')),
      rawFile('broken.jpg', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8])),
    ];
    for (const file of files) {
      const err = await load(file);
      assert(err && /couldn't be read/.test(err), `${file.name}: got “${err}”`);
      assert(!shown($('workspace')), `${file.name}: no workspace for a corrupt file`);
    }
    return files.map((f) => f.name).join(', ');
  });

  await test('Empty file is refused', async () => {
    const err = await load(rawFile('empty.png', 'image/png', new Uint8Array(0)));
    assert(err && /empty/.test(err), `got “${err}”`);
    return err;
  });

  await test('Huge image is refused before decoding (header check)', async () => {
    const err = await load(rawFile('huge.png', 'image/png', pngHeader(20000, 20000, 64)));
    assert(err && /400 megapixels/.test(err), `got “${err}”`);
    return err;
  });

  await test('Large 24 MP JPEG resizes to 25%', async () => {
    const file = await makeFile('camera.jpg', 'image/jpeg', 6000, 4000);
    const t0 = performance.now();
    await fresh(file);
    const t1 = performance.now();
    preset(25);
    const d = await resizeOk();
    const t2 = performance.now();
    expectFile(d, 1500, 1000, 'jpeg');
    return `load ${Math.round(t1 - t0)} ms, resize ${Math.round(t2 - t1)} ms, ${d.size} bytes`;
  });

  await test('EXIF orientation is applied (portrait photo stored sideways)', async () => {
    await fresh(await exifJpeg('rotated.jpg'));
    eq(text('orig-dims'), '200 × 400 px', 'oriented original dimensions');
    preset(50);
    const d = await resizeOk();
    expectFile(d, 100, 200, 'jpeg');
    const top = pixel(d.bitmap, 50, 30);
    const bottom = pixel(d.bitmap, 50, 170);
    assert(top[0] > 180 && top[2] < 80, `top should be red, got ${top}`);
    assert(bottom[2] > 180 && bottom[0] < 80, `bottom should be blue, got ${bottom}`);
    return 'stored 400×200 → shown and saved upright 100×200';
  });

  await test('Enlarging is allowed but warned about', async () => {
    await fresh(await makeFile('small.png', 'image/png', 200, 100));
    type('width', '400');
    assert(shown($('summary-warning')) && /larger than the original/.test(text('summary-warning')), 'enlarge warning');
    const d = await resizeOk();
    expectFile(d, 400, 200, 'png');
    return '200×100 → 400×200';
  });

  await test('Changing a setting removes the outdated result', async () => {
    await fresh(await makeFile('stale.jpg', 'image/jpeg', 800, 600));
    preset(50);
    await resizeOk();
    assert(/smaller|larger|same size/.test(text('res-change')), 'size change reported');
    type('width', '200');
    assert(!shown($('download')) && shown($('result-empty')), 'result cleared after width change');
    await resizeOk();
    choose('png');
    assert(!shown($('download')), 'result cleared after format change');
    choose('original');
    return 'cleared on width and format change';
  });

  await test('Drag and drop: file loads, empty drop shows an error', async () => {
    if (shown($('workspace'))) $('clear-btn').click();
    const dt = new win.DataTransfer();
    dt.items.add(await makeFile('dropped.png', 'image/png', 300, 200));
    const drop = new win.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    $('upload').dispatchEvent(drop);
    await waitFor(() => !busy(), 'drop load');
    assert(drop.defaultPrevented, 'drop default (navigation) prevented');
    eq(text('orig-name'), 'dropped.png', 'dropped file loaded');
    const empty = new win.DataTransfer();
    empty.setData('text/plain', 'not a file');
    doc.body.dispatchEvent(new win.DragEvent('drop', { dataTransfer: empty, bubbles: true, cancelable: true }));
    assert(shown($('load-error')) && /No image file was dropped/.test(text('load-error')), 'no-file error shown');
    return 'loaded dropped.png; empty drop refused';
  });

  await test('Clear resets the tool; resizing with no image is refused', async () => {
    await fresh(await makeFile('reset.png', 'image/png', 300, 200));
    setLock(false);
    choose('jpeg');
    $('clear-btn').click();
    assert(!shown($('workspace')) && shown($('upload')), 'upload shown again');
    eq($('width').value, '', 'width cleared');
    assert($('lock').checked, 'lock back on');
    eq($('format').value, 'original', 'format reset');
    eq(doc.activeElement && doc.activeElement.id, 'choose-btn', 'focus moved to Choose image');
    $('settings').requestSubmit();
    assert(/No image selected/.test(text('resize-error')), 'no-image guard');
    return 'reset to defaults';
  });

  await test('Mobile layout (375 px wide): no sideways scrolling, cards stacked', async () => {
    await fresh(await makeFile('mobile.jpg', 'image/jpeg', 3000, 2000));
    preset(25);
    await resizeOk();
    frame.style.width = '375px';
    const root = doc.documentElement;
    await sleep(500);
    if (root.clientWidth > 375) {
      frame.style.width = '';
      const why = `the iframe did not re-layout (tab is ${document.visibilityState}); open /tests/ in a visible tab`;
      if (document.visibilityState === 'hidden') throw new Skip(why);
      throw new Error(why);
    }
    assert(root.scrollWidth <= root.clientWidth, `page is ${root.scrollWidth}px wide in a ${root.clientWidth}px viewport`);
    const a = $('original-card').getBoundingClientRect();
    const b = $('settings').getBoundingClientRect();
    const c = $('result-card').getBoundingClientRect();
    assert(a.bottom <= b.top && b.bottom <= c.top, 'cards should stack vertically');
    const img = $('original-preview').querySelector('img').getBoundingClientRect();
    assert(img.width <= a.width, 'preview fits its card');
    const detail = `viewport ${root.clientWidth}px, content ${root.scrollWidth}px`;
    frame.style.width = '';
    await sleep(100);
    return detail;
  });

  await test('Only the page’s own static files were requested', async () => {
    const names = win.performance.getEntriesByType('resource').map((e) => e.name);
    const outside = names.filter((n) => !n.startsWith(`${location.origin}/public/`) && !n.startsWith('blob:'));
    eq(outside.length, 0, `requests outside the site (${outside.join(', ')})`);
    return names.map((n) => n.replace(`${location.origin}/public/`, '')).join(', ');
  });

  const passed = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;
  document.getElementById('summary').textContent =
    `${passed} of ${results.length} tests passed` +
    (skipped ? `, ${skipped} skipped` : '') +
    (failed ? ` — ${failed} FAILED` : '') +
    '.';
  window.testResults = results;
})();
