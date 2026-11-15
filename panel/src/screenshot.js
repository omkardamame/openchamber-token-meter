// Rasterise one of our own frames to a PNG with nothing but the platform: no
// dependency, no host API (the host exposes none). The frame is cloned, each
// element's computed style is inlined onto its clone, and the clone is handed
// to the engine through an SVG <foreignObject>, which the engine then draws on
// a canvas. Theme variables become concrete colours on the way, because the copy
// reads computed values rather than the declarations that produced them.
//
// What <foreignObject> does not survive, and this file does not try to fix:
// - box-shadow and backdrop-filter usually drop out of the raster;
// - a web font that only the host document loaded is not available inside the
//   data: SVG document, so text falls back to the next family in the stack;
// - external images (http:, file:) never load inside a data: SVG;
// - an engine that treats the raster as cross-origin taints the canvas, and then
//   toBlob()/toDataURL() throw a SecurityError rather than hand back pixels;
// - a cloned <canvas> carries no pixels and a form control carries no value, so
//   both come out blank;
// - :hover and :focus are frozen at their computed state, not re-applied.

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Long enough for a busy frame, short enough that a raster that never happens
// reports back to the caller instead of hanging the click that asked for it.
const LOAD_TIMEOUT_MS = 8000;

// The properties worth carrying across. A whole-style copy would be slower and
// would also drag over things the SVG document cannot use (custom properties,
// `all`), so this is a fixed list: type first, then the box, borders, paint,
// flex/grid, and the SVG paint properties the chart draws with. Shorthands come
// before their longhands, so the longhands win where a browser serialises both.
const STYLE_PROPS = [
  'color',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-feature-settings',
  'font-variant-numeric',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-decoration',
  'text-overflow',
  'text-shadow',
  'text-transform',
  'white-space',
  'word-break',
  'overflow-wrap',
  'vertical-align',
  'box-sizing',
  'display',
  'position',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'border-collapse',
  'background',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-content',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-column',
  'grid-row',
  'opacity',
  'box-shadow',
  'filter',
  'overflow',
  'overflow-x',
  'overflow-y',
  'visibility',
  'transform',
  'transform-origin',
  'list-style',
  'object-fit',
  'aspect-ratio',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  // <stop> carries its colour as an attribute, and the CSS variable it names
  // does not exist inside the data: document: without these the area fill
  // rasterises black.
  'stop-color',
  'stop-opacity',
];

/**
 * Copy the fixed style list from the live tree onto the clone. Both trees are
 * walked through `children`, which a deep clone is guaranteed to keep aligned.
 * The clone can be detached for this: computed styles follow the source nodes.
 */
function inlineStyles(source, clone) {
  const pairs = [[source, clone]];
  while (pairs.length > 0) {
    const [from, to] = pairs.pop();
    const computed = getComputedStyle(from);
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value) to.style.setProperty(prop, value);
    }
    const fromKids = from.children;
    const toKids = to.children;
    const last = Math.min(fromKids.length, toKids.length);
    for (let i = 0; i < last; i += 1) pairs.push([fromKids[i], toKids[i]]);
  }
}

/** A colour only needs a fillRect when it actually puts paint down. */
function paintsBackground(colour) {
  if (!colour || colour === 'transparent') return false;
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(colour);
  return !(rgba && Number(rgba[1]) === 0);
}

/**
 * Decode the SVG into an image the canvas can draw. An SVG the engine will not
 * rasterise fires no event at all in some builds, so the timeout is the only
 * thing that turns "nothing happened" into an error the caller can report.
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    let timer = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(image);
    };
    timer = setTimeout(() => finish(new Error('capturePng: the SVG image never loaded')), LOAD_TIMEOUT_MS);
    image.onload = () => {
      if (image.naturalWidth > 0) finish();
      else finish(new Error('capturePng: the SVG image decoded to nothing'));
    };
    image.onerror = () => finish(new Error('capturePng: the frame could not be rasterised through <foreignObject>'));
    image.src = url;
    // decode() reports a frame that is not drawable before any event does, but
    // it rejects with an opaque error; the timeout owns that failure, so here it
    // only short-cuts the success path.
    if (typeof image.decode === 'function') image.decode().then(() => finish(), () => {});
  });
}

/**
 * Rasterise `root` to a PNG. Resolves `{ blob, dataUrl, width, height }` with
 * width and height in CSS pixels, as measured at capture time.
 */
export async function capturePng(root, { scale = 2, background = null } = {}) {
  if (!root || root.nodeType !== 1) throw new Error('capturePng: needs an element to capture');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`capturePng: scale must be a positive number, got ${scale}`);

  const box = root.getBoundingClientRect();
  const width = Math.ceil(box.width);
  // `.meter` scrolls, so its rect is the viewport, not the content: the fold
  // would silently cut the Per step block and the footer out of the file.
  const height = Math.ceil(Math.max(box.height, root.scrollHeight));
  if (width <= 0 || height <= 0) throw new Error(`capturePng: nothing to draw, the element measures ${width}×${height}`);

  const clone = root.cloneNode(true);
  inlineStyles(root, clone);
  // The box we measured is a border box, so pin the clone root to that box size
  // under border-box sizing; otherwise padding and borders would be added to it.
  clone.style.boxSizing = 'border-box';
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;

  // A data: URL is parsed as XML, so the clone is serialised by the XML
  // serializer: HTML serialisation leaves <br> and <img> unclosed, which the XML
  // parser rejects. It also declares the XHTML namespace the clone inherits.
  const markup = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%"><div xmlns="${XHTML_NS}">${markup}</div></foreignObject>` +
    `</svg>`;

  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('capturePng: no 2D canvas context available');
  // Fill in device pixels before scaling, so a fractional scale cannot leave an
  // unpainted hairline where the rounded bitmap is wider than width × scale.
  const paint = background ?? getComputedStyle(root).backgroundColor;
  if (paintsBackground(paint)) {
    ctx.fillStyle = paint;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  // Scale the context instead of the bitmap so the engine rasterises the SVG at
  // the full device resolution rather than upscaling a 1x image.
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0, width, height);

  const blob = await Promise.race([
    new Promise((resolve, reject) => {
      // A null blob means the browser refused to encode (usually a canvas over
      // its size limit); that must not read as a successful, empty screenshot.
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('capturePng: the browser refused to encode the PNG'))), 'image/png');
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('capturePng: the PNG encode never finished')), 20_000)),
  ]);

  // No dataUrl: it is a second full encode of the same bitmap, and the caller
  // only ever wanted the blob.
  return { blob, width, height };
}

/** Offer a blob to the user as a download; a missing .png is added. */
export function downloadBlob(blob, name) {
  const base = String(name || 'screenshot');
  const filename = /\.png$/i.test(base) ? base : `${base}.png`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // The click has taken its reference to the blob; releasing the URL on the next
  // tick lets the download start without keeping it alive for the whole session.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
