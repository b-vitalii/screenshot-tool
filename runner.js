const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { collectTexts } = require('./textAudit');

// ────────────────────────────────────────────────────────────────────────────
//  Aspect-ratio presets
//
//  A preset is an aspect ratio + an orientation. The pixel size is derived:
//    landscape → height is fixed (base.landscape), width  = height * w/h
//    portrait  → width  is fixed (base.portrait),  height = width  * h/w
//
//  With the default bases this reproduces the historical hardcoded viewports
//  exactly:  16x9 landscape → 1280x720,  12x20 portrait → 600x1000.
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE = {
    landscape: 720,  // fixed height
    portrait:  600   // fixed width
};

const DEFAULT_RATIOS = {
    landscape: ['16x9'],
    portrait:  ['12x20']
};

// Accepts either an aspect ratio ("16:9", "9x20") or an explicit resolution
// ("1280x720"). Both sides >= 100 means the user typed pixels, not a ratio.
function parseSpec(str) {
    const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*[x:×]\s*(\d+(?:\.\d+)?)$/i);
    if (!m) return null;

    const w = parseFloat(m[1]);
    const h = parseFloat(m[2]);

    if (!(w > 0) || !(h > 0)) return null;

    return { kind: (w >= 100 && h >= 100) ? 'size' : 'ratio', w, h };
}

function specId(spec) {
    return `${spec.w}x${spec.h}`;
}

function specLabel(spec) {
    return spec.kind === 'size' ? `${spec.w}×${spec.h}` : `${spec.w}:${spec.h}`;
}

function presetSize(orientation, spec, base) {
    if (spec.kind === 'size') {
        return { width: Math.round(spec.w), height: Math.round(spec.h) };
    }

    if (orientation === 'landscape') {
        const height = base.landscape;
        return { width: Math.round(height * (spec.w / spec.h)), height };
    }

    const width = base.portrait;
    return { width, height: Math.round(width * (spec.h / spec.w)) };
}

function buildPresets(config) {
    const base = {
        landscape: Number(config.base?.landscape) || DEFAULT_BASE.landscape,
        portrait:  Number(config.base?.portrait)  || DEFAULT_BASE.portrait
    };

    const orientations = config.mode === 'both'
        ? ['landscape', 'portrait']
        : [config.mode];

    const presets = [];

    for (const orientation of orientations) {
        const raw = config.ratios?.[orientation];
        const list = Array.isArray(raw) && raw.length
            ? raw
            : DEFAULT_RATIOS[orientation];

        const seen = new Set();

        for (const item of list) {
            const spec = parseSpec(item);
            if (!spec) continue;

            const id = specId(spec);
            if (seen.has(id)) continue;
            seen.add(id);

            presets.push({
                id,
                label: specLabel(spec),
                orientation,
                ...presetSize(orientation, spec, base)
            });
        }
    }

    // never leave a run with nothing to do
    if (!presets.length) {
        for (const orientation of orientations) {
            const spec = parseSpec(DEFAULT_RATIOS[orientation][0]);
            presets.push({
                id: specId(spec),
                label: specLabel(spec),
                orientation,
                ...presetSize(orientation, spec, base)
            });
        }
    }

    return presets;
}

// ────────────────────────────────────────────────────────────────────────────
//  Layout settling
//
//  Replaces the old fixed `waitForTimeout(500)` after a resize. We confirm the
//  viewport actually reached the page, let two animation frames run so the
//  game's resize handler has relaid everything out, then wait a short settle.
//  Deterministic and, in practice, faster than the flat 500ms.
// ────────────────────────────────────────────────────────────────────────────

async function waitForLayout(page, preset, settleMs = 250) {
    try {
        await page.waitForFunction(
            ({ w, h }) => window.innerWidth === w && window.innerHeight === h,
            { w: preset.width, h: preset.height },
            { timeout: 5000 }
        );
    } catch (e) {
        // viewport never reported the expected size — keep going, the fixed
        // settle below still gives the game a chance to catch up
    }

    try {
        await page.evaluate(
            () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
    } catch (e) { /* page busy — ignore */ }

    if (settleMs > 0) await page.waitForTimeout(settleMs);
}

async function applyPreset(page, preset, settleMs) {
    await page.setViewportSize({ width: preset.width, height: preset.height });
    await waitForLayout(page, preset, settleMs);
}

// ────────────────────────────────────────────────────────────────────────────

async function skipStartScreen(page) {
    await page.evaluate(() => {
        window.TestActions.closeStartScreen();
    });

    await page.waitForFunction(() => {
        return window.TestVars?.isStartScreenClosed === true;
    }, { timeout: 10000 });

    await page.waitForTimeout(1400);

    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    await page.mouse.click(x, y);
}

// There used to be an unconditional page.mouse.click(10, 10) here, before the
// start-screen shots. That point sits exactly on the in-game DevTools button
// (left 6px / top 6px, 24x24), so the click was swallowed by that DOM element
// and never reached the game canvas — it did nothing except open the toolbar,
// which then covered every screenshot. Moving it to clear ground made it land
// on the canvas for the first time, where the game read it as a tap and closed
// the start screen. So the click was never needed: it is gone.
//
// If some game ever does need one interaction first, pass startClickX/startClickY
// in the run config and it will click there. Nothing clicks by default.
// Note for that case: do NOT use y ≈ 36–60, that is the Additional DevTools
// button, directly below the core one.

function filePrefix(gameName) {
    return gameName ? `${gameName}_` : '';
}

async function runForLang(browser, {
    url, lang, workerId, presets, pagesCount, selectedPages, status,
    onScreenshot, enSocExtra, screenshotStartScreen, gameName, settleMs,
    textChecks, shots, startClick
}) {
    const context = await browser.newContext();
    const page = await context.newPage();

    const isEnSoc = lang === 'en-soc' && enSocExtra;
    let pagesCounts = Number.isFinite(pagesCount) ? pagesCount : 10;
    if (isEnSoc) pagesCounts += 1;

    const finalUrl = buildFinalUrl(url, lang, workerId);
    const prefix = filePrefix(gameName);

    // load straight into the first preset's size so the game never lays out
    // against a viewport we are not going to screenshot
    await page.setViewportSize({ width: presets[0].width, height: presets[0].height });

    await page.goto(finalUrl);

    await page.waitForLoadState('domcontentloaded');

    await page.waitForFunction(() => {
        return window.TestFuncs && window.TestFuncs.canCloseStartScreen?.();
    }, { timeout: 30000 });

    await page.waitForFunction(() => {
        const c = document.querySelector('canvas');
        return c && c.width > 0;
    });

    await page.waitForTimeout(1000);

    const baseDir = path.join(__dirname, 'screenshots', lang);
    if (fs.existsSync(baseDir)) {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(baseDir, { recursive: true });

    if (screenshotStartScreen) {
        if (startClick) await page.mouse.click(startClick.x, startClick.y);
        await page.waitForTimeout(3500);

        for (const preset of presets) {
            checkCancel(status);

            status.workers[workerId] = {
                lang,
                mode: `start · ${preset.orientation} ${preset.label}`
            };

            const dir = path.join(
                baseDir,
                'startscreen',
                `${preset.orientation}_${preset.id}`
            );
            fs.mkdirSync(dir, { recursive: true });

            await applyPreset(page, preset, settleMs);

            for (let s = 1; s <= 3; s++) {
                const name = `${prefix}${lang}_${preset.orientation}_${preset.id}_startscreen_${s}.png`;

                if (textChecks && s === 1) {
                    const snap = await collectTexts(page);
                    shots.push({
                        lang,
                        orientation: preset.orientation,
                        ratio: preset.id,
                        page: s,
                        kind: 'startscreen',
                        file: name,
                        url: `/file/${lang}/startscreen/${preset.orientation}_${preset.id}/${name}`,
                        viewport: snap.viewport || { w: preset.width, h: preset.height },
                        items: snap.items,
                        skipped: snap.skipped
                    });
                }

                await page.screenshot({ path: path.join(dir, name) });
                onScreenshot?.();
                if (s < 3) await page.waitForTimeout(600);
            }
        }
    }

    await skipStartScreen(page);

    for (let p = 0; p < presets.length; p++) {
        const preset = presets[p];
        checkCancel(status);

        status.workers[workerId] = {
            lang,
            mode: `${preset.orientation} ${preset.label}`
        };

        const dir = path.join(baseDir, preset.orientation, preset.id);
        fs.mkdirSync(dir, { recursive: true });

        await applyPreset(page, preset, settleMs);

        if (p === 0) {
            await page.evaluate(() => {
                GR.UI.view.rules_menu.visible(true);
            });
            await page.waitForTimeout(50);
        }

        const realPagesCount = await page.evaluate(() => {
            try {
                const vals = GR.UI.view.rules_menu.values();
                return Array.isArray(vals) ? vals.length : null;
            } catch (e) {
                return null;
            }
        });

        const totalPages = realPagesCount || pagesCounts;

        for (let i = 1; i <= totalPages; i++) {
            checkCancel(status);

            const shouldScreenshot =
                !selectedPages || selectedPages.length === 0
                || selectedPages.includes(i);

            if (shouldScreenshot) {
                const name = `${prefix}${lang}_${preset.orientation}_${preset.id}_page-${i}.png`;

                if (textChecks) {
                    const snap = await collectTexts(page);
                    shots.push({
                        lang,
                        orientation: preset.orientation,
                        ratio: preset.id,
                        page: i,
                        kind: 'page',
                        file: name,
                        url: `/file/${lang}/${preset.orientation}/${preset.id}/${name}`,
                        viewport: snap.viewport || { w: preset.width, h: preset.height },
                        items: snap.items,
                        skipped: snap.skipped
                    });
                }

                await page.screenshot({ path: path.join(dir, name) });

                if (onScreenshot) {
                    onScreenshot();
                }
            }

            if (i < totalPages) {
                await page.evaluate(() => {
                    GR.UI.view.rules_menu.down.click();
                });
                await page.waitForTimeout(50);
            }
        }

        const hasNextPreset = p < presets.length - 1;

        if (hasNextPreset) {
            // wrap the rules menu back around to page 1 for the next preset
            await page.evaluate(() => {
                GR.UI.view.rules_menu.down.click();
            });
            await page.waitForTimeout(50);
        }
    }

    await context.close();
    console.log(`${lang} finished`);
}

function checkCancel(status) {
    if (status.cancel) {
        throw new Error('CANCELLED');
    }
}

function chunkArray(arr, chunks) {
    const result = Array.from({ length: chunks }, () => []);

    arr.forEach((item, i) => {
        result[i % chunks].push(item);
    });

    return result;
}

function buildFinalUrl(url, lang, workerId) {
    const u = new URL(url);

    u.searchParams.set('lang', lang);

    const token = u.searchParams.get('token');

    if (token) {
        u.searchParams.set(
            'token',
            `${token}_w${workerId}_${lang}`
        );
    }

    return u.toString();
}

async function runJob(config, status, browsers) {

    const workersCount = Math.min(
        config.workers || 1,
        4,
        config.langs.length
    );

    const langs = config.langs || ['en'];

    const presets = buildPresets(config);
    const settleMs = Number.isFinite(config.settleMs) ? config.settleMs : 250;
    const textChecks = config.textChecks !== false;
    const shots = [];

    // no pre-shot click unless a run explicitly asks for one
    const startClick = (Number.isFinite(config.startClickX) && Number.isFinite(config.startClickY))
        ? { x: config.startClickX, y: config.startClickY }
        : null;

    console.log(
        'presets:',
        presets.map(p => `${p.orientation} ${p.label} → ${p.width}x${p.height}`).join(', ')
    );

    const chunks = chunkArray(langs, workersCount);

    let totalTasks = 0;

    for (const lang of langs) {
        const pagesCount =
            lang === 'en-soc' && config.enSocExtra
                ? config.pagesCount + 1
                : config.pagesCount;

        const effectivePages =
            config.pages && config.pages.length
                ? config.pages.length
                : pagesCount;

        totalTasks += effectivePages * presets.length;

        if (config.screenshotStartScreen) totalTasks += presets.length * 3;
    }

    status.total = totalTasks;
    status.presets = presets.map(p => ({
        id: p.id,
        label: p.label,
        orientation: p.orientation,
        width: p.width,
        height: p.height
    }));

    let completedTasks = 0;

    await Promise.all(
        chunks.map(async (chunk, workerId) => {

            const browser = await chromium.launch({
                channel: 'chrome',
                headless: config.headless ?? true,
                args: [
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                ]
            });
            browsers.push(browser);

            try {
                for (const lang of chunk) {
                    status.workers[workerId] = {
                        lang,
                        mode: ''
                    };

                    await runForLang(browser, {
                        url: config.url,
                        lang,
                        workerId,
                        presets,
                        pagesCount: config.pagesCount,
                        selectedPages: config.pages,
                        status,
                        enSocExtra: config.enSocExtra,
                        screenshotStartScreen: config.screenshotStartScreen,
                        gameName: config.gameName,
                        settleMs,
                        textChecks,
                        shots,
                        startClick,
                        onScreenshot: () => {
                            completedTasks++;
                            if (completedTasks > totalTasks) {
                                completedTasks = totalTasks;
                            }
                            status.progress = Math.min(
                                100,
                                Math.round((completedTasks / totalTasks) * 100)
                            );
                        }
                    });

                }

            } finally {
                delete status.workers[workerId];
                await Promise.race([
                    browser.close(),
                    new Promise(res => setTimeout(res, 3000))
                ]).catch(console.error);
            }
        })
    );

    return { shots };
}

module.exports = { runJob, buildPresets };
