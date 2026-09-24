# Free Image Resizer

A small static web app that resizes JPG, PNG and WebP images and lets you download the result.
Everything happens **locally in the browser**: the image is never uploaded, and there is no
backend, database, account system, analytics or third-party script.

## What it does

- Open an image with the file picker or by dragging it onto the page.
- Resize by width, by height, or by both. Aspect-ratio lock is on by default, and turning it
  off lets you stretch the image on purpose.
- Quick presets: 25%, 50%, 75% and 100% of the original size. Presets never enlarge the image.
- Output as the original format, JPG, PNG or WebP. JPG and WebP have a quality slider
  (default 85%). PNG is lossless and has no quality setting.
- Shows the original's file name, format, dimensions and file size, plus the result's format,
  dimensions, file size and percentage change. The result figures are read from the generated
  file itself.
- Warns when converting a transparent image to JPG (transparent areas become white), when the
  image will be stretched, and when you enlarge it.
- Downloads as `original-name-resized.<ext>`.

## Privacy: how "processed locally" is guaranteed

- The browser decodes the file, `<canvas>` resizes it, and `canvas.toBlob()` encodes it. The
  download is a local `blob:` URL.
- The page's Content-Security-Policy (a `<meta>` tag in `index.html`) sets `connect-src 'none'`,
  so the page's scripts *cannot* send data over the network (no `fetch`, XHR, WebSocket or
  beacon). The test suite checks this.
- No external fonts, scripts, analytics or trackers are loaded.

## Supported formats

| Input | Output |
| --- | --- |
| JPG / JPEG, PNG, WebP | Original format, JPG, PNG, WebP |

- The format is detected from the file's contents, not its name.
- Safari can't *encode* WebP. There, the WebP option is disabled and "Original format" for a
  WebP file saves as PNG, with a note explaining why.

## Limits (to avoid crashing the browser tab)

| Limit | Value |
| --- | --- |
| File size | 100 MB |
| Original image | 100 megapixels (checked from the file header *before* decoding) |
| Result | 16,384 px per side, 100 megapixels |

Phones have less memory than these limits assume. If the browser can't allocate an image, the
app shows an error instead of failing silently. The limits are the `LIMITS` constant at the
top of `public/app.js`.

## Run it locally

It's plain static files, so any static web server works:

```bash
python -m http.server 8000 --directory public
```

Then open <http://localhost:8000>. (`npx serve public` works too.)

### Tests

`tests/` is an in-browser test suite. It drives the real page through its UI and decodes the
actual download blobs to check format, dimensions and pixels. Serve the **project root** and
open `/tests/`:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765/tests/> in a visible browser tab. The mobile-layout test resizes
an iframe, and a hidden or background tab may not re-layout.

## Deploy to Cloudflare Pages

No build step is needed. The site is the `public/` folder.

**As a Worker (`npx wrangler deploy`):** `wrangler.jsonc` tells Wrangler to serve `./public` as
static assets, with no server code. Its `name` must match the Worker's name in the Cloudflare
dashboard.

**From Git:** push this repository, then in Cloudflare go to *Workers & Pages → Create → Pages →
Connect to Git*. Set:

- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: **`public`**

**Direct upload:** in *Workers & Pages → Create → Pages → Upload assets*, upload the contents of
`public/`. Alternatively, use Wrangler:

```bash
npx wrangler pages deploy public --project-name free-image-resizer
```

**Before going live**, replace `https://free-image-resizer.pages.dev/` with your real domain in
`public/index.html` (canonical, `og:url` and JSON-LD), `public/robots.txt` and
`public/sitemap.xml`.

`public/_headers` adds security headers on Cloudflare Pages. `public/404.html` stops Pages from
serving the home page for every unknown URL.

## Project structure

```text
public/                 ← deployed site (Cloudflare Pages output directory)
  index.html            page markup, SEO meta tags, CSP, help/FAQ text
  styles.css            all styles (no framework)
  app.js                all behaviour: loading, validation, resizing, download
  404.html              not-found page
  _headers              Cloudflare Pages security headers
  robots.txt, sitemap.xml
  favicon.svg, favicon.ico, apple-touch-icon.png
tests/
  index.html, tests.js  in-browser test suite (not deployed)
wrangler.jsonc          Wrangler config: serves ./public as static assets
README.md
```

## Dependencies

None. The app uses only browser-native APIs: File, Blob, Canvas 2D and `URL.createObjectURL`.
There are no npm packages, frameworks, build tools, CDNs or environment variables.

## Notes and limitations

- **Metadata is removed.** Canvas output has no EXIF data (camera, GPS). EXIF orientation is
  applied to the pixels, so photos stay upright.
- **Colour profiles** are converted to sRGB by the browser. Wide-gamut photos may shift
  slightly.
- **Animated WebP/PNG:** only the first frame is resized.
- **Quality:** large reductions are done in halving steps with high-quality smoothing, which
  gives clean results in every browser. It isn't a Lanczos resampler.
- **Very large images** are resized on the main thread, so the page can pause briefly (about 1 s
  for a 24 MP photo on a desktop).

## Adding ads later

`index.html` marks the ad position between the tool and the help text, and `.ad-slot` in
`styles.css` reserves its height to prevent layout shift. When you add an ad network, update the
CSP `<meta>` tag to allow its script and connection domains. Note that third-party scripts can
read the page, so review the privacy statement at the same time.
