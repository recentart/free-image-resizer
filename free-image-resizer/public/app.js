/*
 * Free Image Resizer
 *
 * Everything here runs in the visitor's browser. The chosen file is decoded by
 * the browser, drawn onto a <canvas> at the new size and encoded with
 * canvas.toBlob(). Nothing is sent over the network (the page's CSP also sets
 * connect-src 'none').
 */
(() => {
  'use strict';

  // Guards against crashing the tab. The real ceiling depends on the device's
  // memory; anything the browser still can't allocate is caught and reported.
  const LIMITS = {
    maxFileBytes: 100 * 1024 * 1024,
    maxInputPixels: 100e6,
    maxSide: 16384,
    maxOutputPixels: 100e6,
  };
  const HEADER_BYTES = 512 * 1024;
  const FORMATS = {
    jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
    png: { mime: 'image/png', ext: 'png', label: 'PNG' },
    webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
  };
  const LOCKED_HINT = 'Change the width or height and the other side updates to keep the original proportions.';
  const UNLOCKED_HINT = "Width and height can be set separately. If they don't match the original proportions, the image will be stretched.";
  const TOO_BIG = "Your browser couldn't create an image this large. It may have run out of memory. Try smaller dimensions.";

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'),
    loadError: $('load-error'),
    fileInput: $('file-input'),
    upload: $('upload'),
    chooseBtn: $('choose-btn'),
    workspace: $('workspace'),
    originalPreview: $('original-preview'),
    origName: $('orig-name'),
    origFormat: $('orig-format'),
    origDims: $('orig-dims'),
    origSize: $('orig-size'),
    changeBtn: $('change-btn'),
    clearBtn: $('clear-btn'),
    form: $('settings'),
    settingsTitle: $('settings-title'),
    presets: Array.from(document.querySelectorAll('[data-scale]')),
    width: $('width'),
    height: $('height'),
    widthError: $('width-error'),
    heightError: $('height-error'),
    dimsError: $('dims-error'),
    lock: $('lock'),
    lockHint: $('lock-hint'),
    format: $('format'),
    formatOriginal: $('format-original'),
    formatWebp: $('format-webp'),
    formatNote: $('format-note'),
    alphaWarning: $('alpha-warning'),
    qualityField: $('quality-field'),
    quality: $('quality'),
    qualityValue: $('quality-value'),
    summaryDims: $('summary-dims'),
    summaryDetail: $('summary-detail'),
    summaryWarning: $('summary-warning'),
    resizeBtn: $('resize-btn'),
    resizeLabel: $('resize-label'),
    resizeError: $('resize-error'),
    resultTitle: $('result-title'),
    resultEmpty: $('result-empty'),
    resultBody: $('result-body'),
    resultPreview: $('result-preview'),
    resFormat: $('res-format'),
    resDims: $('res-dims'),
    resSize: $('res-size'),
    resChange: $('res-change'),
    resName: $('res-name'),
    resNote: $('res-note'),
    download: $('download'),
    status: $('status'),
  };

  const state = {
    image: null, // the loaded original, see readImage()
    resultUrl: null, // object URL of the current resized file
    driver: 'width', // the dimension the user last typed into
    loadToken: 0, // bumped to discard an in-flight load
    resultToken: 0, // bumped to discard an in-flight or outdated resize
    busy: 0,
  };

  // Safari can decode WebP but can't encode it; it silently returns PNG instead.
  const canEncodeWebP = (() => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      return c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch (_) {
      return false;
    }
  })();

  class UserError extends Error {}

  // ---------- small helpers ----------

  const fmtInt = (n) => n.toLocaleString('en-US');
  const dimsText = (w, h) => `${fmtInt(w)} × ${fmtInt(h)} px`;
  const scaleSide = (side, factor) => Math.max(1, Math.round(side * factor));

  function megapixels(px) {
    const mp = px / 1e6;
    return mp >= 10 ? fmtInt(Math.round(mp)) : String(Math.round(mp * 10) / 10);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function showMessage(el, text) {
    el.textContent = text || '';
    el.hidden = !text;
  }

  function announce(text) {
    els.status.textContent = text;
  }

  function setBusy(delta) {
    state.busy = Math.max(0, state.busy + delta);
    els.app.setAttribute('aria-busy', String(state.busy > 0));
  }

  function baseName(name) {
    const base = name
      .replace(/\.[^./\\]+$/, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return base || 'image';
  }

  function formatFromMime(mime) {
    return Object.keys(FORMATS).find((key) => FORMATS[key].mime === mime) || null;
  }

  // Resolves when the browser has had a chance to paint (e.g. "Resizing…").
  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      setTimeout(resolve, 100); // rAF is paused in background tabs
    });
  }

  // ---------- reading the original ----------

  // Identifies the real format from the file's first bytes, not its name.
  function sniffFormat(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length >= 8 && png.every((v, i) => b[i] === v)) return 'png';
    const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (b.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'webp';
    return null;
  }

  // Reads the pixel size from the file header so oversized images can be
  // rejected before the browser decodes them. Returns null if unknown.
  function headerSize(b, format) {
    const u16be = (i) => (b[i] << 8) | b[i + 1];
    const u16le = (i) => b[i] | (b[i + 1] << 8);
    const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    const u32be = (i) => b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
    const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

    if (format === 'png') {
      return b.length >= 24 && tag(12) === 'IHDR' ? { w: u32be(16), h: u32be(20) } : null;
    }
    if (format === 'webp') {
      if (b.length < 30) return null;
      const chunk = tag(12);
      if (chunk === 'VP8X') return { w: 1 + u24le(24), h: 1 + u24le(27) };
      if (chunk === 'VP8 ') return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG: walk the marker segments until the start-of-frame marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: u16be(i + 7), h: u16be(i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + u16be(i + 2);
    }
    return null;
  }

  function tooManyPixels(w, h) {
    return new UserError(
      `This image is ${fmtInt(w)} × ${fmtInt(h)} pixels (${megapixels(w * h)} megapixels). ` +
        `The maximum is ${megapixels(LIMITS.maxInputPixels)} megapixels. Please use a smaller image.`
    );
  }

  function decodeImage(img, url) {
    return new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    }).then(() => (img.decode ? img.decode() : undefined));
  }

  // Checks a small copy of the image for any pixel that isn't fully opaque.
  function detectAlpha(img, width, height) {
    const scale = Math.min(1, 512 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(w, h);
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
      }
      return false;
    } catch (_) {
      return false;
    } finally {
      freeCanvas(canvas);
    }
  }

  async function readImage(file) {
    const name = file.name || 'image';
    if (file.size === 0) throw new UserError(`“${name}” is empty (0 bytes). Please choose a different image.`);
    if (file.size > LIMITS.maxFileBytes) {
      throw new UserError(`“${name}” is ${formatBytes(file.size)}. The maximum file size is ${formatBytes(LIMITS.maxFileBytes)}.`);
    }

    const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    const format = sniffFormat(head);
    if (!format) {
      const claimsSupported = /^image\/(jpe?g|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(name);
      throw new UserError(
        claimsSupported
          ? `“${name}” couldn't be read. The file may be damaged, or it isn't really a JPG, PNG or WebP image.`
          : `“${name}” isn't a supported file type. Please choose a JPG, PNG or WebP image.`
      );
    }
    const header = headerSize(head, format);
    if (header && header.w * header.h > LIMITS.maxInputPixels) throw tooManyPixels(header.w, header.h);

    // One decoded copy serves as both the preview and the resize source.
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await decodeImage(img, url);
    } catch (_) {
      URL.revokeObjectURL(url);
      throw new UserError(`“${name}” couldn't be read. The file may be damaged or incomplete.`);
    }
    // naturalWidth/Height already have the EXIF orientation applied.
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) {
      URL.revokeObjectURL(url);
      throw new UserError(`“${name}” couldn't be read. The file may be damaged or incomplete.`);
    }
    if (width * height > LIMITS.maxInputPixels) {
      URL.revokeObjectURL(url);
      throw tooManyPixels(width, height);
    }
    const hasAlpha = format !== 'jpeg' && detectAlpha(img, width, height);
    return { file, name, format, width, height, url, img, hasAlpha };
  }

  function releaseImage(image) {
    if (image) URL.revokeObjectURL(image.url);
  }

  async function loadFile(file) {
    const token = ++state.loadToken;
    showMessage(els.loadError, '');
    setBusy(1);
    try {
      const image = await readImage(file);
      if (token !== state.loadToken) {
        releaseImage(image);
        return;
      }
      useImage(image);
    } catch (err) {
      if (token === state.loadToken) {
        showMessage(
          els.loadError,
          err instanceof UserError ? err.message : `“${file.name}” couldn't be opened. Please try a different image.`
        );
      }
    } finally {
      setBusy(-1);
    }
  }

  function useImage(image) {
    const focusWasLost = !els.workspace.contains(document.activeElement);
    releaseImage(state.image);
    state.image = image;

    const label = FORMATS[image.format].label;
    image.img.alt = `Original image: ${image.name}`;
    els.originalPreview.replaceChildren(image.img);
    els.origName.textContent = image.name;
    els.origFormat.textContent = label;
    els.origDims.textContent = dimsText(image.width, image.height);
    els.origSize.textContent = formatBytes(image.file.size);
    els.formatOriginal.textContent = `Original format (${label})`;

    els.width.value = String(image.width);
    els.height.value = String(image.height);
    state.driver = 'width';

    els.upload.hidden = true;
    els.workspace.hidden = false;
    settingsChanged();
    if (focusWasLost) els.settingsTitle.focus({ preventScroll: true });
    announce(`Loaded ${image.name}: ${dimsText(image.width, image.height)}, ${formatBytes(image.file.size)}.`);
  }

  // ---------- settings ----------

  function parseDim(raw, label) {
    const text = raw.trim();
    if (!text) return { error: `Enter a ${label.toLowerCase()} in pixels.` };
    if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return { error: `${label} must be a number, like 800.` };
    const value = Number(text);
    if (value < 1) return { error: `${label} must be at least 1 pixel.` };
    if (!Number.isInteger(value)) return { error: `${label} must be a whole number of pixels.` };
    if (value > LIMITS.maxSide) return { error: `${label} can't be more than ${fmtInt(LIMITS.maxSide)} pixels.` };
    return { value };
  }

  function setFieldError(input, errorEl, message) {
    showMessage(errorEl, message);
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  // Validates both fields, shows any errors and returns {w, h} or null.
  function readDims() {
    const w = parseDim(els.width.value, 'Width');
    const h = parseDim(els.height.value, 'Height');
    setFieldError(els.width, els.widthError, w.error);
    setFieldError(els.height, els.heightError, h.error);
    let areaError = '';
    if (!w.error && !h.error && w.value * h.value > LIMITS.maxOutputPixels) {
      areaError =
        `${fmtInt(w.value)} × ${fmtInt(h.value)} would be ${megapixels(w.value * h.value)} megapixels. ` +
        `The maximum is ${megapixels(LIMITS.maxOutputPixels)} megapixels. Please use smaller dimensions.`;
      els.width.setAttribute('aria-invalid', 'true');
      els.height.setAttribute('aria-invalid', 'true');
    }
    showMessage(els.dimsError, areaError);
    return w.error || h.error || areaError ? null : { w: w.value, h: h.value };
  }

  function isProportional(dims, image) {
    return (
      Math.abs(dims.h - (dims.w * image.height) / image.width) <= 1 ||
      Math.abs(dims.w - (dims.h * image.width) / image.height) <= 1
    );
  }

  function resolveOutput() {
    const choice = els.format.value;
    let key = choice === 'original' ? state.image.format : choice;
    let note = '';
    if (key === 'webp' && !canEncodeWebP) {
      key = 'png';
      note = "This browser can't create WebP files, so the result will be saved as PNG.";
    }
    const f = FORMATS[key];
    const quality = key === 'png' ? undefined : Number(els.quality.value) / 100;
    return { key, mime: f.mime, ext: f.ext, label: f.label, quality, note };
  }

  // Re-validates the form and updates the summary, presets and format notes.
  function refresh() {
    const image = state.image;
    if (!image) return;
    const dims = readDims();
    const out = resolveOutput();

    for (const btn of els.presets) {
      const factor = Number(btn.dataset.scale) / 100;
      const on = !!dims && dims.w === scaleSide(image.width, factor) && dims.h === scaleSide(image.height, factor);
      btn.setAttribute('aria-pressed', String(on));
    }

    const warnings = [];
    if (dims) {
      const proportional = isProportional(dims, image);
      const pct = (dims.w / image.width) * 100;
      els.summaryDims.textContent = dimsText(dims.w, dims.h);
      els.summaryDetail.textContent = [
        proportional ? `${pct < 1 ? 'Less than 1%' : `${Math.round(pct)}%`} of the original` : 'Stretched',
        out.label,
      ].join(' · ');
      if (!proportional) {
        warnings.push("The width and height don't match the original proportions, so the image will be stretched.");
      }
      if (dims.w > image.width || dims.h > image.height) {
        warnings.push('This is larger than the original. Enlarged images can look soft or blurry.');
      }
    } else {
      els.summaryDims.textContent = '—';
      els.summaryDetail.textContent = 'Enter a valid width and height.';
    }
    showMessage(els.summaryWarning, warnings.join(' '));

    els.qualityField.hidden = out.key === 'png';
    const pngNote =
      out.key === 'png'
        ? 'PNG is lossless and keeps transparency, so it has no quality setting. PNG files are often larger than JPG or WebP.'
        : '';
    showMessage(els.formatNote, [out.note, pngNote].filter(Boolean).join(' '));
    els.alphaWarning.hidden = !(out.key === 'jpeg' && image.hasAlpha);
    els.lockHint.textContent = els.lock.checked ? LOCKED_HINT : UNLOCKED_HINT;
  }

  // Any change makes an existing result outdated, so it is removed.
  function settingsChanged() {
    state.resultToken++;
    clearResult();
    showMessage(els.resizeError, '');
    showMessage(els.loadError, '');
    refresh();
  }

  function syncOther(which) {
    const image = state.image;
    const source = parseDim(which === 'width' ? els.width.value : els.height.value, '');
    if (!image || source.error) return;
    if (which === 'width') els.height.value = String(scaleSide(source.value, image.height / image.width));
    else els.width.value = String(scaleSide(source.value, image.width / image.height));
  }

  function onDimensionInput(which) {
    state.driver = which;
    if (els.lock.checked) syncOther(which);
    settingsChanged();
  }

  // ---------- resizing ----------

  function createCanvas(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  function context2d(canvas, opaque) {
    const ctx = canvas.getContext('2d', opaque ? { alpha: false } : undefined);
    if (!ctx) throw new UserError(TOO_BIG);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  // Setting the size to 0 releases the canvas memory straight away (notably on iOS).
  function freeCanvas(canvas) {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  // Large reductions are done in halving steps so every browser averages
  // neighbouring pixels instead of skipping them (which looks jagged).
  function drawScaled(source, sw, sh, tw, th, opaque) {
    let current = source;
    let cw = sw;
    let ch = sh;
    let temp = null;
    while (cw > tw * 2 || ch > th * 2) {
      const nw = cw > tw * 2 ? Math.ceil(cw / 2) : cw;
      const nh = ch > th * 2 ? Math.ceil(ch / 2) : ch;
      const step = createCanvas(nw, nh);
      context2d(step).drawImage(current, 0, 0, nw, nh);
      freeCanvas(temp);
      temp = step;
      current = step;
      cw = nw;
      ch = nh;
    }
    const out = createCanvas(tw, th);
    const ctx = context2d(out, opaque);
    if (opaque) {
      // JPG has no transparency: fill with white, or browsers would use black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
    }
    ctx.drawImage(current, 0, 0, tw, th);
    freeCanvas(temp);
    return out;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob(resolve, mime, quality);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function encode(image, dims, out) {
    let canvas = null;
    try {
      canvas = drawScaled(image.img, image.width, image.height, dims.w, dims.h, out.key === 'jpeg');
      const blob = await canvasToBlob(canvas, out.mime, out.quality);
      if (!blob || !blob.size) throw new UserError(TOO_BIG);
      return blob;
    } catch (err) {
      throw err instanceof UserError ? err : new UserError(TOO_BIG);
    } finally {
      freeCanvas(canvas);
    }
  }

  function sizeChange(newSize, oldSize) {
    const pct = ((newSize - oldSize) / oldSize) * 100;
    if (Math.abs(pct) < 0.5) return 'About the same size as the original';
    if (pct < 0) return `${Math.min(99, Math.round(-pct))}% smaller than the original`;
    return `${Math.round(pct)}% larger than the original`;
  }

  async function resize() {
    showMessage(els.resizeError, '');
    const image = state.image;
    if (!image) {
      showMessage(els.resizeError, 'No image selected. Please choose a JPG, PNG or WebP image first.');
      return;
    }
    const dims = readDims();
    if (!dims) {
      showMessage(els.resizeError, 'Please fix the size settings above first.');
      (els.height.hasAttribute('aria-invalid') && !els.width.hasAttribute('aria-invalid') ? els.height : els.width).focus();
      return;
    }

    const out = resolveOutput();
    const token = ++state.resultToken;
    clearResult();
    setBusy(1);
    els.resizeBtn.disabled = true;
    els.resizeLabel.textContent = 'Resizing…';
    try {
      await nextPaint();
      if (token !== state.resultToken) return;
      const blob = await encode(image, dims, out);
      if (token !== state.resultToken) return;
      await showResult(blob, dims, out, image, token);
    } catch (err) {
      if (token === state.resultToken) {
        showMessage(
          els.resizeError,
          err instanceof UserError ? err.message : 'Something went wrong while resizing. Try smaller dimensions or another image.'
        );
      }
    } finally {
      setBusy(-1);
      els.resizeBtn.disabled = false;
      els.resizeLabel.textContent = 'Resize image';
    }
  }

  async function showResult(blob, dims, out, image, token) {
    // Report what the browser actually produced, not what was requested.
    const actual = formatFromMime(blob.type) || out.key;
    const format = FORMATS[actual];
    const url = URL.createObjectURL(blob);
    const img = new Image();
    try {
      await decodeImage(img, url);
    } catch (_) {
      URL.revokeObjectURL(url);
      throw new UserError(TOO_BIG);
    }
    if (token !== state.resultToken) {
      URL.revokeObjectURL(url);
      return;
    }
    // The dimensions shown come from decoding the generated file itself.
    if (img.naturalWidth !== dims.w || img.naturalHeight !== dims.h) {
      URL.revokeObjectURL(url);
      throw new UserError(
        `Your browser produced a ${dimsText(img.naturalWidth, img.naturalHeight)} image instead of ` +
          `${dimsText(dims.w, dims.h)}. Please try smaller dimensions or another browser.`
      );
    }

    const fileName = `${baseName(image.name)}-resized.${format.ext}`;
    const change = sizeChange(blob.size, image.file.size);
    img.alt = `Resized image preview, ${dimsText(dims.w, dims.h)}`;
    els.resultPreview.replaceChildren(img);
    state.resultUrl = url;
    els.resFormat.textContent = format.label;
    els.resDims.textContent = dimsText(dims.w, dims.h);
    els.resSize.textContent = formatBytes(blob.size);
    els.resChange.textContent = change;
    els.resName.textContent = fileName;

    const notes = [];
    if (actual !== out.key) notes.push(`Your browser can't create ${out.label} files, so this was saved as ${format.label}.`);
    if (blob.size > image.file.size) {
      notes.push(
        'The new file is larger than the original. This can happen when enlarging, converting to PNG, ' +
          'or using a higher quality setting than the original file used.'
      );
    }
    showMessage(els.resNote, notes.join(' '));

    els.download.href = url;
    els.download.download = fileName;
    els.resultEmpty.hidden = true;
    els.resultBody.hidden = false;
    els.resultTitle.focus();
    announce(`Resized to ${dimsText(dims.w, dims.h)}. New file size ${formatBytes(blob.size)}, ${change.toLowerCase()}.`);
  }

  function clearResult() {
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null;
    els.resultPreview.replaceChildren();
    els.download.removeAttribute('href');
    els.resultBody.hidden = true;
    els.resultEmpty.hidden = false;
  }

  function clearAll() {
    state.loadToken++;
    state.resultToken++;
    clearResult();
    releaseImage(state.image);
    state.image = null;
    els.originalPreview.replaceChildren();
    els.form.reset();
    els.qualityValue.textContent = `${els.quality.value}%`;
    els.formatOriginal.textContent = 'Original format';
    setFieldError(els.width, els.widthError, '');
    setFieldError(els.height, els.heightError, '');
    for (const el of [els.dimsError, els.summaryWarning, els.resizeError, els.loadError]) showMessage(el, '');
    els.workspace.hidden = true;
    els.upload.hidden = false;
    els.chooseBtn.focus();
    announce('Image cleared. Choose a new image to resize.');
  }

  // ---------- events ----------

  els.chooseBtn.addEventListener('click', () => els.fileInput.click());
  els.changeBtn.addEventListener('click', () => els.fileInput.click());
  els.upload.addEventListener('click', (e) => {
    if (!e.target.closest('button')) els.fileInput.click();
  });
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = ''; // lets the same file be chosen again later
    if (file) loadFile(file);
  });

  // The whole page accepts drops, and a missed drop never navigates away.
  let dragDepth = 0;
  const isFileDrag = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!isFileDrag(e)) return;
    dragDepth++;
    document.body.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('is-dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    const files = e.dataTransfer ? e.dataTransfer.files : null;
    if (!files || !files.length) {
      showMessage(els.loadError, 'No image file was dropped. Drag a JPG, PNG or WebP file from your device, or use “Choose image”.');
      return;
    }
    loadFile(files[0]);
  });

  els.width.addEventListener('input', () => onDimensionInput('width'));
  els.height.addEventListener('input', () => onDimensionInput('height'));
  els.lock.addEventListener('change', () => {
    if (els.lock.checked) syncOther(state.driver);
    settingsChanged();
  });
  for (const btn of els.presets) {
    btn.addEventListener('click', () => {
      if (!state.image) return;
      const factor = Number(btn.dataset.scale) / 100;
      els.width.value = String(scaleSide(state.image.width, factor));
      els.height.value = String(scaleSide(state.image.height, factor));
      state.driver = 'width';
      settingsChanged();
    });
  }
  els.format.addEventListener('change', settingsChanged);
  els.quality.addEventListener('input', () => {
    els.qualityValue.textContent = `${els.quality.value}%`;
    settingsChanged();
  });
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    resize();
  });
  els.clearBtn.addEventListener('click', clearAll);

  // ---------- start ----------

  els.form.reset();
  els.qualityValue.textContent = `${els.quality.value}%`;
  if (!canEncodeWebP) {
    els.formatWebp.disabled = true;
    els.formatWebp.textContent = 'WebP (not supported by this browser)';
  }
})();
