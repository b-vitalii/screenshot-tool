// ────────────────────────────────────────────────────────────────────────────
//  textAudit.js
//
//  Two halves:
//    1. collectTexts(page)  — runs inside the browser, snapshots every visible
//       piece of text with its geometry. Knows nothing about what is "wrong".
//    2. analyze(shots)      — pure Node, turns those snapshots into findings.
//
//  The paytable is HTML (slotscore renders it with mustache and hands it to the
//  platform via GR.setData('paytable', …)), so everything here is DOM-based.
//
//  There is deliberately NO "is something drawn over this text" hit test. One
//  existed and was removed: elementsFromPoint-based occlusion threw away 59% of
//  the real paytable text on live games (8.2 dropped vs 5.7 kept per shot),
//  because sampling a few points on a line is not a reliable proxy for "the
//  player cannot see this". The effective-visibility walk is what actually
//  matters, and on a stacked carousel it is sufficient on its own — verified
//  against a carousel whose inactive pages are hidden with opacity:0.
//
//  IMPORTANT: geometry comes from Range.getClientRects() over the element's own
//  text nodes, NOT from element.getBoundingClientRect(). An element's box
//  includes all of its children, so box-based checks fire on text that is
//  nowhere near anything — that was the source of the overlap false positives.
//  Range rects are the actual rendered glyph boxes.
// ────────────────────────────────────────────────────────────────────────────

const ENGLISH_VARIANTS = ['en', 'en-soc'];

// ── 1. in-page collector ────────────────────────────────────────────────────
// Serialised and executed by Playwright. Must be fully self-contained.

function pageCollector() {
    const MAX_ITEMS = 500;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CANVAS', 'TEMPLATE', 'IFRAME', 'SVG', 'OPTION']);

    let measureCtx = null;
    function widestWord(text, font) {
        try {
            if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
            measureCtx.font = font;
            let max = 0;
            for (const w of text.split(/\s+/)) {
                const m = measureCtx.measureText(w).width;
                if (m > max) max = m;
            }
            return Math.round(max);
        } catch (e) { return 0; }
    }

    // the real glyph boxes of this element's own text — one per rendered line
    function ownTextRects(el) {
        const rects = [];
        for (const n of el.childNodes) {
            if (n.nodeType !== 3) continue;
            if (!n.nodeValue || !n.nodeValue.trim()) continue;
            let range;
            try {
                range = document.createRange();
                range.selectNodeContents(n);
                for (const r of range.getClientRects()) {
                    if (r.width > 0.5 && r.height > 0.5) {
                        rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
                    }
                }
            } catch (e) { /* skip this node */ }
        }
        return rects;
    }

    function union(rects) {
        if (!rects.length) return null;
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const r of rects) {
            x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
            x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
        }
        return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
    }

    function domPath(el) {
        const parts = [];
        let node = el;
        while (node && node !== document.body && parts.length < 24) {
            const parent = node.parentElement;
            if (!parent) break;
            let i = 0;
            for (const sib of parent.children) {
                if (sib === node) break;
                if (sib.tagName === node.tagName) i++;
            }
            parts.unshift(`${node.tagName.toLowerCase()}[${i}]`);
            node = parent;
        }
        return parts.join('/');
    }

    // Ancestors that clip their content.
    //
    // <body> and <html> are deliberately excluded: games set overflow:hidden on
    // them and lay everything out with position:fixed, so body's own box can be
    // a few pixels tall while filling the screen visually. Comparing against it
    // marks every single text as "cut off". Clipping at the window edge is what
    // the offscreen check is for. Degenerate boxes are skipped for the same
    // reason.
    function clippingAncestors(el) {
        const out = [];
        let node = el.parentElement;
        while (node && node !== document.documentElement && out.length < 12) {
            if (node.tagName === 'BODY') break;

            let cs;
            try { cs = getComputedStyle(node); } catch (e) { break; }

            if (/hidden|clip|auto|scroll/.test(cs.overflowX + ' ' + cs.overflowY)) {
                const r = node.getBoundingClientRect();
                if (r.width >= 4 && r.height >= 4) {
                    out.push({
                        tag: node.tagName.toLowerCase(),
                        x: r.left, y: r.top, w: r.width, h: r.height,
                        overflowX: cs.overflowX, overflowY: cs.overflowY
                    });
                }
            }
            node = node.parentElement;
        }
        return out;
    }

    // A paytable is a carousel: every page lives in the DOM at once and the
    // inactive ones are hidden. Hiding by opacity on a WRAPPER does not change
    // the child's own computed opacity, so a naive check leaks the text of every
    // page — stacked at identical coordinates. That is what produced "overlap"
    // on things that plainly do not overlap. Two guards below.

    function effectivelyVisible(el) {
        try {
            if (typeof el.checkVisibility === 'function'
                && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
                return false;
            }
        } catch (e) { /* fall through to the manual walk */ }

        let node = el, hops = 0;
        while (node && node !== document.documentElement && hops++ < 40) {
            let cs;
            try { cs = getComputedStyle(node); } catch (e) { return false; }
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
            if (parseFloat(cs.opacity || '1') < 0.05) return false;
            node = node.parentElement;
        }
        return true;
    }

    // Paytable images are handed over as base64 data URLs (Paytable.getImage
    // returns renderer.extract.base64), so the src must never be stored — it
    // would be megabytes per shot. A short human label is enough.
    function imageLabel(el) {
        const src = el.getAttribute('src') || '';
        if (!src) return 'image without src';
        if (/^data:/i.test(src)) return el.alt ? `${el.alt} (embedded)` : 'embedded image';
        const clean = src.split('?')[0].split('#')[0];
        const base = clean.substring(clean.lastIndexOf('/') + 1);
        return (base || 'image').slice(0, 48);
    }

    // ── opaque bounds ───────────────────────────────────────────────────────
    // A symbol PNG carries transparent padding, so its element box is much
    // bigger than the visible artwork. Checking that box reports overlaps and
    // overflows that nobody can see. So: draw the image into a tiny offscreen
    // canvas, read the alpha channel, and find the box of the pixels that are
    // actually painted. Paytable images are base64 data URLs — same-origin —
    // so the canvas is readable. A cross-origin image taints it, getImageData
    // throws, and we simply fall back to the element box.
    const INK_SCAN = 48;
    const ALPHA_MIN = 16;
    const inkCache = new Map();

    function opaqueFraction(el) {
        const src = el.currentSrc || el.src || '';
        const key = src.length + '|' + src.slice(-64);
        if (inkCache.has(key)) return inkCache.get(key);

        let res = null;
        try {
            const nw = el.naturalWidth, nh = el.naturalHeight;
            if (nw && nh) {
                const sw = Math.max(1, Math.min(INK_SCAN, nw));
                const sh = Math.max(1, Math.min(INK_SCAN, nh));
                const c = document.createElement('canvas');
                c.width = sw; c.height = sh;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(el, 0, 0, sw, sh);
                const d = ctx.getImageData(0, 0, sw, sh).data;

                let x1 = sw, y1 = sh, x2 = -1, y2 = -1;
                for (let y = 0; y < sh; y++) {
                    for (let x = 0; x < sw; x++) {
                        if (d[(y * sw + x) * 4 + 3] > ALPHA_MIN) {
                            if (x < x1) x1 = x;
                            if (x > x2) x2 = x;
                            if (y < y1) y1 = y;
                            if (y > y2) y2 = y;
                        }
                    }
                }

                res = (x2 >= x1 && y2 >= y1)
                    ? { x: x1 / sw, y: y1 / sh, w: (x2 - x1 + 1) / sw, h: (y2 - y1 + 1) / sh }
                    : { blank: true };
            }
        } catch (e) {
            res = null;   // tainted canvas → fall back to the element box
        }

        inkCache.set(key, res);
        return res;
    }

    const images = [];
    const MAX_IMAGES = 200;

    for (const el of (document.body ? document.body.querySelectorAll('img') : [])) {
        if (images.length >= MAX_IMAGES) break;
        if (!effectivelyVisible(el)) continue;

        const r = el.getBoundingClientRect();

        // still downloading when the shot was taken — not a defect
        if (!el.complete) continue;

        let cs;
        try { cs = getComputedStyle(el); } catch (e) { continue; }

        const box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };

        // where the painted pixels actually are. Only meaningful for the default
        // object-fit: contain/cover letterbox the picture inside the box, so the
        // mapping would not be a simple scale.
        let ink = null, blank = false;
        const frac = (cs.objectFit || 'fill') === 'fill' ? opaqueFraction(el) : null;
        if (frac && frac.blank) blank = true;
        else if (frac) {
            ink = {
                x: Math.round(r.left + frac.x * r.width),
                y: Math.round(r.top + frac.y * r.height),
                w: Math.round(frac.w * r.width),
                h: Math.round(frac.h * r.height)
            };
        }

        const hit = ink || box;
        const visW = Math.min(hit.x + hit.w, vw) - Math.max(hit.x, 0);
        const visH = Math.min(hit.y + hit.h, vh) - Math.max(hit.y, 0);

        images.push({
            path: domPath(el),
            label: imageLabel(el),
            hasSrc: !!el.getAttribute('src'),
            rect: box,
            ink,                       // null when unknown → checks use the box
            inkKnown: !!ink,
            blank,
            natW: el.naturalWidth,
            natH: el.naturalHeight,
            objectFit: cs.objectFit || 'fill',
            clips: clippingAncestors(el),
            offscreen: visW <= 0 || visH <= 0
        });
    }

    const items = [];
    const skipped = { hidden: 0, offscreen: 0 };
    const all = document.body ? document.body.querySelectorAll('*') : [];

    for (const el of all) {
        if (items.length >= MAX_ITEMS) break;
        if (SKIP_TAGS.has(el.tagName)) continue;

        let own = '';
        for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
        own = own.replace(/\s+/g, ' ').trim();
        if (!own) continue;

        let cs;
        try { cs = getComputedStyle(el); } catch (e) { continue; }
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (parseFloat(cs.opacity || '1') < 0.05) continue;

        if (!effectivelyVisible(el)) { skipped.hidden++; continue; }

        const lineRects = ownTextRects(el);
        const textRect = union(lineRects);
        if (!textRect || textRect.w < 2 || textRect.h < 2) continue;

        // Text that lies entirely outside the viewport gets collected but flagged.
        // Geometry findings are pointless for it (no pixel on the screenshot to
        // point a box at), yet its STRING is still worth checking: a missing
        // translation is missing regardless of where the layout pushed it. This
        // used to be a hard skip, and it silently swallowed a real translation
        // defect whenever a narrow column shoved the string off screen.
        const visW = Math.min(textRect.x + textRect.w, vw) - Math.max(textRect.x, 0);
        const visH = Math.min(textRect.y + textRect.h, vh) - Math.max(textRect.y, 0);
        const offscreen = visW <= 0 || visH <= 0;
        if (offscreen) skipped.offscreen++;


        const box = el.getBoundingClientRect();
        const fontSize = parseFloat(cs.fontSize) || 0;
        const lineHeightRaw = parseFloat(cs.lineHeight);
        const lineHeight = Number.isFinite(lineHeightRaw) ? lineHeightRaw : fontSize * 1.2;

        const scale = el.offsetWidth > 0
            ? Math.round((box.width / el.offsetWidth) * 1000) / 1000
            : 1;

        items.push({
            path: domPath(el),
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className.slice(0, 60) : '') || null,
            text: own.length > 300 ? own.slice(0, 300) + '…' : own,
            rect: textRect,                       // real glyphs, used by every check
            lines: lineRects.length || 1,
            fontSize,
            lineHeight,
            scale,
            scrollW: el.scrollWidth,
            clientW: el.clientWidth,
            scrollH: el.scrollHeight,
            clientH: el.clientHeight,
            overflowX: cs.overflowX,
            overflowY: cs.overflowY,
            whiteSpace: cs.whiteSpace,
            widestWord: widestWord(own, cs.font || `${fontSize}px sans-serif`),
            clips: clippingAncestors(el),
            offscreen
        });
    }

    return { viewport: { w: vw, h: vh }, items, images, skipped };
}

async function collectTexts(page) {
    try {
        return await page.evaluate(pageCollector);
    } catch (e) {
        return { viewport: null, items: [], error: String((e && e.message) || e) };
    }
}

// ── 2. analysis ─────────────────────────────────────────────────────────────

const BROKEN = new Set([
    'offscreen', 'clipped', 'long-word', 'overlap', 'raw-key',
    'image-broken', 'image-offscreen', 'image-clipped', 'image-stretched',
    'image-over-text', 'image-over-image'
]);

// an image whose displayed aspect is this far off its natural one is squashed
const ASPECT_TOLERANCE = 0.1;

const KEY_RE = /^[A-Za-z][A-Za-z0-9]*(?:[._][A-Za-z0-9]+)+$/;

// px slack before we call something a defect — kills rounding/antialias noise
const SLACK = 3;

function isRawKey(text) {
    if (!text || text.length < 6 || text.length > 80) return false;
    if (/\s/.test(text)) return false;
    if (!KEY_RE.test(text)) return false;
    if (/^[\d._]+$/.test(text)) return false;
    if (/\.(com|net|org|io|tech|dev)$/i.test(text)) return false;
    return true;
}

function isComparableText(text) {
    if (!text || text.length < 3) return false;
    return /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿ぁ-ゟ゠-ヿ一-鿿가-힣]/.test(text);
}

// A tight line-height makes the line boxes of two ADJACENT elements overlap by a
// couple of pixels without a single glyph touching, so a bare area ratio is not
// enough — the overlapping region itself has to be substantial.
const OVERLAP_MIN_W = 8;    // px
const OVERLAP_MIN_H = 4;    // px
const OVERLAP_MIN_SHARE = 0.3;

function overlapBox(a, b) {
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return { w, h, area: w * h };
}

function issue(shot, type, severity, message, item, extra) {
    return {
        type,
        severity,
        group: BROKEN.has(type) ? 'broken' : 'suspect',
        message,
        lang: shot.lang,
        orientation: shot.orientation,
        ratio: shot.ratio,
        page: shot.page,
        kind: shot.kind || 'page',
        url: shot.url,
        file: shot.file,
        viewport: shot.viewport,
        rect: item && !item.offscreen ? item.rect : null,
        offscreen: item ? !!item.offscreen : false,
        text: item ? item.text : null,
        path: item ? item.path : null,
        ...(extra || {})
    };
}

// ── per-shot geometry ───────────────────────────────────────────────────────

function analyzeShot(shot, opts) {
    const found = [];
    const vp = shot.viewport;
    if (!vp) return found;

    for (const it of shot.items) {
        // off the shot entirely → geometry means nothing, only the string counts
        if (it.offscreen) {
            if (opts.suspects && isRawKey(it.text)) {
                found.push(issue(shot, 'raw-key', 'error',
                    `Looks like an untranslated key: ${it.text} (not visible in this shot)`, it));
            }
            continue;
        }

        const r = it.rect;

        // 1 · glyphs outside the viewport
        const out = Math.max(
            Math.max(0, -r.x),
            Math.max(0, -r.y),
            Math.max(0, (r.x + r.w) - vp.w),
            Math.max(0, (r.y + r.h) - vp.h)
        );

        if (out > SLACK) {
            const area = Math.max(1, r.w * r.h);
            const visW = Math.max(0, Math.min(r.x + r.w, vp.w) - Math.max(r.x, 0));
            const visH = Math.max(0, Math.min(r.y + r.h, vp.h) - Math.max(r.y, 0));
            const hidden = Math.round((1 - (visW * visH) / area) * 100);
            found.push(issue(
                shot, 'offscreen', hidden > 20 ? 'error' : 'warn',
                `Text sticks out of the screen by ${Math.round(out)}px (${hidden}% hidden)`,
                it, { outPx: Math.round(out), hiddenRatio: hidden }
            ));
        }

        // 2 · cut off — by its own box, or by a clipping ancestor
        const selfX = it.clientW > 0 && it.scrollW > it.clientW + SLACK && /hidden|clip/.test(it.overflowX);
        const selfY = it.clientH > 0 && it.scrollH > it.clientH + SLACK && /hidden|clip/.test(it.overflowY);

        let byAncestor = null;
        for (const c of it.clips) {
            const overX = /hidden|clip/.test(c.overflowX) && (r.x < c.x - SLACK || r.x + r.w > c.x + c.w + SLACK);
            const overY = /hidden|clip/.test(c.overflowY) && (r.y < c.y - SLACK || r.y + r.h > c.y + c.h + SLACK);
            if (overX || overY) { byAncestor = c; break; }
        }

        if (selfX || selfY || byAncestor) {
            const px = selfX ? it.scrollW - it.clientW : (selfY ? it.scrollH - it.clientH : 0);
            const by = (selfX || selfY) ? `by its own <${it.tag}> box` : `by <${byAncestor.tag}>`;
            found.push(issue(
                shot, 'clipped', 'error',
                `Text is cut off ${by}${px > 0 ? ` (${px}px does not fit)` : ''}`,
                it, { overflowPx: px }
            ));
        }

        // 3 · a single word wider than its container — it physically cannot wrap
        if (it.clientW > 0 && it.widestWord > it.clientW + SLACK && it.whiteSpace !== 'nowrap') {
            found.push(issue(
                shot, 'long-word', 'warn',
                `Longest word is ${it.widestWord}px, container is ${it.clientW}px — it cannot wrap`,
                it, { widestWord: it.widestWord, clientW: it.clientW }
            ));
        }

        // 4 · a raw i18n key made it to the screen
        if (opts.suspects && isRawKey(it.text)) {
            found.push(issue(shot, 'raw-key', 'error', `Looks like an untranslated key: ${it.text}`, it));
        }
    }

    // 5 · glyphs overlapping glyphs — opt-in, and rarely useful. In normal HTML
    //     flow text does not overlap text, and a text lying fully on top of
    //     another makes the lower one "covered", so that pair never reaches this
    //     comparison. Partial overlaps can still surface here.
    if (opts.overlap) {
        const onScreen = shot.items.filter(it => !it.offscreen);
        for (let i = 0; i < onScreen.length; i++) {
            for (let j = i + 1; j < onScreen.length; j++) {
                const a = onScreen[i], b = onScreen[j];
                if (a.path.startsWith(b.path) || b.path.startsWith(a.path)) continue;

                const ov = overlapBox(a.rect, b.rect);
                if (ov.w < OVERLAP_MIN_W || ov.h < OVERLAP_MIN_H) continue;

                const smaller = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
                if (smaller > 0 && ov.area / smaller >= OVERLAP_MIN_SHARE) {
                    found.push(issue(
                        shot, 'overlap', 'warn',
                        `Overlaps another text (“${b.text.slice(0, 40)}”) by ${Math.round((ov.area / smaller) * 100)}%`,
                        a, { withText: b.text, withRect: b.rect }
                    ));
                }
            }
        }
    }

    // ── images ──────────────────────────────────────────────────────────────
    //
    // Geometry uses the OPAQUE box (im.ink) whenever we could read it, not the
    // element box. A symbol PNG is mostly transparent padding, and judging by the
    // element box reports overlaps and overflows that are invisible on screen.
    for (const im of (shot.images || [])) {
        const box = im.rect;
        const hit = im.ink || box;          // what the player actually sees
        const as = { rect: hit, text: im.label, path: im.path, offscreen: im.offscreen };

        // 1 · did not load, collapsed, or nothing but transparency
        if (!im.hasSrc || im.natW === 0) {
            found.push(issue(shot, 'image-broken', 'error',
                !im.hasSrc ? 'Image has no src' : 'Image failed to load (renders as nothing)', as));
            continue;
        }
        if (im.natW >= 8 && (box.w < 3 || box.h < 3)) {
            found.push(issue(shot, 'image-broken', 'error',
                `Image renders at ${box.w}×${box.h} although the file is ${im.natW}×${im.natH}`, as));
            continue;
        }
        if (im.blank) {
            found.push(issue(shot, 'image-broken', 'error',
                'Image is fully transparent — nothing is painted', as));
            continue;
        }

        if (im.offscreen) continue;

        // 2 · painted pixels leaving the screen
        const out = Math.max(
            Math.max(0, -hit.x), Math.max(0, -hit.y),
            Math.max(0, (hit.x + hit.w) - vp.w), Math.max(0, (hit.y + hit.h) - vp.h)
        );
        if (out > SLACK) {
            const visW = Math.max(0, Math.min(hit.x + hit.w, vp.w) - Math.max(hit.x, 0));
            const visH = Math.max(0, Math.min(hit.y + hit.h, vp.h) - Math.max(hit.y, 0));
            const hidden = Math.round((1 - (visW * visH) / Math.max(1, hit.w * hit.h)) * 100);
            found.push(issue(shot, 'image-offscreen', hidden > 20 ? 'error' : 'warn',
                `Image sticks out of the screen by ${Math.round(out)}px (${hidden}% of the picture hidden)`, as));
        }

        // 3 · cut off by a clipping container
        for (const c of im.clips) {
            const overX = /hidden|clip/.test(c.overflowX) && (hit.x < c.x - SLACK || hit.x + hit.w > c.x + c.w + SLACK);
            const overY = /hidden|clip/.test(c.overflowY) && (hit.y < c.y - SLACK || hit.y + hit.h > c.y + c.h + SLACK);
            if (overX || overY) {
                found.push(issue(shot, 'image-clipped', 'error', `Image is cut off by <${c.tag}>`, as));
                break;
            }
        }

        // 4 · squashed — compares the file to the box, transparency irrelevant
        if (im.objectFit === 'fill' && im.natH > 0 && box.w >= 20 && box.h >= 20) {
            const k = (box.w / box.h) / (im.natW / im.natH);
            if (k < 1 - ASPECT_TOLERANCE || k > 1 + ASPECT_TOLERANCE) {
                const pct = Math.round(Math.abs(k - 1) * 100);
                found.push(issue(shot, 'image-stretched', 'warn',
                    `Image is ${k > 1 ? 'stretched' : 'squeezed'} by ${pct}% — shown ${box.w}×${box.h}, file is ${im.natW}×${im.natH}`, as));
            }
        }

        if (!opts.overlap) continue;

        // 5 · painted pixels sitting on text
        for (const it of shot.items) {
            if (it.offscreen) continue;
            const ov = overlapBox(hit, it.rect);
            if (ov.w < OVERLAP_MIN_W || ov.h < OVERLAP_MIN_H) continue;
            const smaller = Math.min(hit.w * hit.h, it.rect.w * it.rect.h);
            if (smaller > 0 && ov.area / smaller >= OVERLAP_MIN_SHARE) {
                found.push(issue(shot, 'image-over-text', 'warn',
                    `Image overlaps the text (“${it.text.slice(0, 40)}”) by ${Math.round((ov.area / smaller) * 100)}%`,
                    as, { withText: it.text, withRect: it.rect }));
                break;
            }
        }
    }

    // 6 · picture on picture. Often deliberate (overlapping symbol icons), so it
    //     is opt-in and, being identical in every language, collapses into a
    //     single "all N langs → layout" card rather than a flood.
    if (opts.overlap) {
        const imgs = (shot.images || []).filter(im => !im.offscreen && im.natW > 0 && !im.blank);
        for (let i = 0; i < imgs.length; i++) {
            for (let j = i + 1; j < imgs.length; j++) {
                const a = imgs[i].ink || imgs[i].rect;
                const b = imgs[j].ink || imgs[j].rect;
                const ov = overlapBox(a, b);
                if (ov.w < OVERLAP_MIN_W || ov.h < OVERLAP_MIN_H) continue;
                const smaller = Math.min(a.w * a.h, b.w * b.h);
                if (smaller > 0 && ov.area / smaller >= OVERLAP_MIN_SHARE) {
                    found.push(issue(shot, 'image-over-image', 'warn',
                        `Image overlaps another image (“${imgs[j].label}”) by ${Math.round((ov.area / smaller) * 100)}%`,
                        { rect: a, text: imgs[i].label, path: imgs[i].path },
                        { withImage: imgs[j].label, withRect: b }));
                }
            }
        }
    }

    return found;
}

// ── cross-language ──────────────────────────────────────────────────────────

function analyzeLanguages(shots, opts) {
    const found = [];
    const english = new Set(opts.englishVariants);

    const groups = new Map();
    for (const s of shots) {
        if ((s.kind || 'page') !== 'page') continue;
        const k = `${s.orientation}|${s.ratio}|${s.page}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
    }

    for (const [, group] of groups) {
        const refShot = group.find(s => s.lang === 'en') || group.find(s => english.has(s.lang));
        if (!refShot) continue;

        const refByPath = new Map(refShot.items.map(it => [it.path, it]));
        const others = group.filter(s => !english.has(s.lang));
        if (!others.length) continue;

        const perPath = new Map();
        for (const s of others) {
            for (const it of s.items) {
                if (!refByPath.has(it.path)) continue;
                if (!perPath.has(it.path)) perPath.set(it.path, []);
                perPath.get(it.path).push({ lang: s.lang, shot: s, item: it });
            }
        }

        for (const [path, entries] of perPath) {
            const ref = refByPath.get(path);
            if (!isComparableText(ref.text)) continue;

            const same = entries.filter(e => e.item.text === ref.text);
            const total = entries.length;

            // suspicion comes from "matches English while the others translated it",
            // never from "matches English" alone — that is a universal term
            if (opts.suspects && total >= 3 && same.length >= 1 && same.length <= Math.max(1, Math.floor(total * 0.4))) {
                for (const e of same) {
                    found.push(issue(
                        e.shot, 'fallback', 'warn',
                        `Same as English while ${total - same.length}/${total} languages translated it — probably a missing translation`
                        + (e.item.offscreen ? ' (not visible in this shot)' : ''),
                        e.item, { reference: ref.text, translatedCount: total - same.length, totalLangs: total }
                    ));
                }
            }

            for (const e of entries) {
                // these two compare LAYOUT, so a string that is off the shot has
                // nothing meaningful to measure
                if (e.item.offscreen || ref.offscreen) continue;

                const refPx = ref.fontSize * (ref.scale || 1);
                const px = e.item.fontSize * (e.item.scale || 1);
                if (refPx > 0 && px > 0) {
                    const k = px / refPx;
                    if (k < 0.85) {
                        found.push(issue(
                            e.shot, 'font-shrink', k < 0.7 ? 'warn' : 'info',
                            `Font is ${Math.round((1 - k) * 100)}% smaller than in English (${px.toFixed(1)}px vs ${refPx.toFixed(1)}px)`,
                            e.item, { factor: Math.round(k * 100) }
                        ));
                    }
                }
                if (e.item.lines >= ref.lines + 2) {
                    found.push(issue(
                        e.shot, 'wrap-growth', 'info',
                        `Wraps to ${e.item.lines} lines instead of ${ref.lines} in English`,
                        e.item, { lines: e.item.lines, refLines: ref.lines }
                    ));
                }
            }
        }

        if (opts.suspects) {
            for (const s of others) {
                const comparable = s.items.filter(it => refByPath.has(it.path) && isComparableText(refByPath.get(it.path).text));
                if (comparable.length < 5) continue;
                const identical = comparable.filter(it => it.text === refByPath.get(it.path).text);
                if (identical.length / comparable.length >= 0.8) {
                    found.push(issue(
                        s, 'page-untranslated', 'error',
                        `Whole page matches English (${identical.length}/${comparable.length} strings) — the locale block looks missing`,
                        null, { identical: identical.length, comparable: comparable.length }
                    ));
                }
            }
        }
    }

    return found;
}

// ── grouping ────────────────────────────────────────────────────────────────
//
//  One defect must read as one row. The same clipped string in 27 languages is
//  a single layout bug, not 27 problems; the same key missing in 2 languages is
//  a single translation bug. So issues collapse by
//  (type · element · orientation · ratio · page) and carry the language list.

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

function groupIssues(issues) {
    const map = new Map();

    for (const i of issues) {
        const key = [i.type, i.path || '-', i.orientation, i.ratio, i.kind, i.page].join('|');

        if (!map.has(key)) {
            map.set(key, {
                key,
                type: i.type,
                group: i.group,
                severity: i.severity,
                orientation: i.orientation,
                ratio: i.ratio,
                page: i.page,
                kind: i.kind,
                path: i.path,
                message: i.message,
                text: i.text,
                langs: [],
                samples: {},
                count: 0
            });
        }

        const f = map.get(key);
        if (!f.langs.includes(i.lang)) f.langs.push(i.lang);
        // keep the worst severity and the most dramatic sample per language
        if (SEVERITY_RANK[i.severity] < SEVERITY_RANK[f.severity]) {
            f.severity = i.severity;
            f.message = i.message;
        }
        f.samples[i.lang] = {
            url: i.url, file: i.file, rect: i.rect,
            viewport: i.viewport, text: i.text, message: i.message
        };
        f.count++;
    }

    const findings = [...map.values()];
    for (const f of findings) {
        f.langs.sort();
        f.langCount = f.langs.length;
        // a defect present in every language is a layout problem, not a locale one
        f.everywhere = false;
    }

    findings.sort((a, b) =>
        (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        || (b.langCount - a.langCount)
        || a.type.localeCompare(b.type)
        || a.page - b.page
    );

    return findings;
}

/**
 * @param shots array of { lang, orientation, ratio, page, kind, url, file, viewport, items }
 * @param opts  { suspects?: boolean, overlap?: boolean, englishVariants?: string[] }
 */
function analyze(shots, opts = {}) {
    const o = {
        suspects: opts.suspects !== false,
        overlap: opts.overlap === true,
        englishVariants: opts.englishVariants || ENGLISH_VARIANTS
    };

    let issues = [];
    for (const s of shots) {
        try { issues = issues.concat(analyzeShot(s, o)); } catch (e) { /* one bad shot must not sink the run */ }
    }
    try { issues = issues.concat(analyzeLanguages(shots, o)); } catch (e) { /* ditto */ }

    if (!o.suspects) issues = issues.filter(i => i.group === 'broken');

    // a wholly untranslated page already explains every fallback on it
    const deadPages = new Set(
        issues.filter(i => i.type === 'page-untranslated')
              .map(i => `${i.lang}|${i.orientation}|${i.ratio}|${i.page}`)
    );
    if (deadPages.size) {
        issues = issues.filter(i =>
            i.type !== 'fallback'
            || !deadPages.has(`${i.lang}|${i.orientation}|${i.ratio}|${i.page}`)
        );
    }

    const findings = groupIssues(issues);

    // diagnostics: how much the visibility guards filtered out. Useful to see
    // at a glance whether a paytable keeps every page in the DOM at once.
    const skipped = { hidden: 0, offscreen: 0 };
    for (const sh of shots) {
        if (sh.skipped) {
            skipped.hidden += sh.skipped.hidden || 0;
            skipped.offscreen += sh.skipped.offscreen || 0;
        }
    }

    const langsSeen = new Set(shots.map(s => s.lang));
    for (const f of findings) f.everywhere = f.langCount >= langsSeen.size && langsSeen.size > 1;

    const byType = {};
    const byLang = {};
    for (const f of findings) {
        byType[f.type] = (byType[f.type] || 0) + 1;
        for (const l of f.langs) byLang[l] = (byLang[l] || 0) + 1;
    }

    return {
        total: findings.length,
        broken: findings.filter(f => f.group === 'broken').length,
        suspect: findings.filter(f => f.group === 'suspect').length,
        rawIssues: issues.length,
        shots: shots.length,
        texts: shots.reduce((n, sh) => n + (sh.items ? sh.items.length : 0), 0),
        images: shots.reduce((n, sh) => n + (sh.images ? sh.images.length : 0), 0),
        skipped,
        languages: [...langsSeen].sort(),
        byType,
        byLang,
        findings
    };
}

module.exports = { collectTexts, analyze, groupIssues, ENGLISH_VARIANTS };
