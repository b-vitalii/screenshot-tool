const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const viewports = {
    landscape: { width: 1280, height: 720 },
    portrait: { width: 600, height: 1000 }
};

// const coords = {
//     landscape: { x: 583, y: 327 },
//     portrait: { x: 577, y: 907 }
// };
//
// const coordsPaytable = {
//     landscape: { x: 583, y: 282 },
//     portrait: { x: 559, y: 804 }
// };
//
// const nextPageCoords = {
//     landscape: { x: 280, y: 160 },
//     portrait: { x: 320, y: 320 }
// };

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

// async function skipStartScreen(page, { lang, baseDir, screenshotStartScreen, onScreenshot } = {}) {
//     if (screenshotStartScreen) {
//         fs.mkdirSync(baseDir, { recursive: true });
//         await page.screenshot({
//             path: path.join(baseDir, `${lang}_startscreen.png`)
//         });
//         if (onScreenshot) onScreenshot();
//     }
//
//     await page.evaluate(() => {
//         window.TestActions.closeStartScreen();
//     });
//
//     await page.waitForFunction(() => {
//         return window.TestVars?.isStartScreenClosed === true;
//     }, { timeout: 10000 });
//
//     await page.waitForTimeout(1400);
//
//     const canvas = await page.$('canvas');
//     const box = await canvas.boundingBox();
//     const x = box.x + box.width / 2;
//     const y = box.y + box.height / 2;
//
//     await page.mouse.click(x, y);
//     await page.waitForTimeout(150);
//     await page.mouse.click(x, y);
// }

async function runForLang(browser, { url, lang, workerId, modes, pagesCount, selectedPages, status, onScreenshot, enSocExtra, screenshotStartScreen }) {
    // const page = await browser.newPage();
    const context = await browser.newContext();
    const page = await context.newPage();

    const isEnSoc = lang === 'en-soc' && enSocExtra;
    let pagesCounts = Number.isFinite(pagesCount) ? pagesCount : 10;
    if (isEnSoc) pagesCounts += 1;

    // const finalUrl = buildFinalUrl(url, lang);
    const finalUrl = buildFinalUrl(url, lang, workerId);

    await page.goto(finalUrl);

    if (modes.length === 1) await page.setViewportSize(viewports[modes[0]]);

    await page.waitForLoadState('domcontentloaded');

    await page.waitForFunction(() => {
        return window.TestFuncs && window.TestFuncs.canCloseStartScreen?.();
    }, { timeout: 30000 });

    // await page.waitForTimeout(3500);

    await page.waitForFunction(() => {
        const c = document.querySelector('canvas');
        return c && c.width > 0;
    });

    // await page.waitForTimeout(100);
    // await safeSkipIntro(page);
    // await skipStartScreen(page);

    const baseDir = path.join(__dirname, 'screenshots', lang);
    if (fs.existsSync(baseDir)) {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(baseDir, { recursive: true });

    if (screenshotStartScreen) {
        await page.mouse.click(10, 10);
        await page.waitForTimeout(3500);

        const startscreenDir = path.join(baseDir, 'startscreen');
        fs.mkdirSync(startscreenDir, { recursive: true });

        for (const mode of modes) {
            await page.setViewportSize(viewports[mode]);
            await page.waitForTimeout(100);
            // await page.screenshot({
            //     path: path.join(startscreenDir, `${lang}_startscreen_${mode}.png`)
            // });
            // onScreenshot?.();

            for (let s = 1; s <= 3; s++) {
                await page.screenshot({
                    path: path.join(startscreenDir, `${lang}_startscreen_${mode}_${s}.png`)
                });
                onScreenshot?.();
                if (s < 3) await page.waitForTimeout(600);
            }

            await page.waitForTimeout(50);
        }
    }

    await skipStartScreen(page);
    // await skipStartScreen(page, {
    //     lang,
    //     baseDir,
    //     screenshotStartScreen,
    //     onScreenshot
    // });

    for (let m = 0; m < modes.length; m++) {

        const mode = modes[m];
        checkCancel(status);

        // status.stage = `${lang} - ${mode}`;
        status.workers[workerId] = {
            lang,
            mode
        };

        // const isLandscape = mode === 'landscape';

        // const point = isLandscape
        //     ? coords.landscape
        //     : coords.portrait;
        //
        // const paytable = isLandscape
        //     ? coordsPaytable.landscape
        //     : coordsPaytable.portrait;
        //
        // const nextPage = isLandscape
        //     ? nextPageCoords.landscape
        //     : nextPageCoords.portrait;

        const dir = path.join(baseDir, mode);
        fs.mkdirSync(dir, { recursive: true });

        await page.setViewportSize(viewports[mode]);
        await page.waitForTimeout(500);

        if (m === 0){
            // await page.mouse.click(point.x, point.y);
            // await page.waitForTimeout(200);
            // await page.mouse.click(paytable.x, paytable.y)
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
                await page.screenshot({
                    path: path.join(dir, `${lang}_page-${i}.png`)
                });

                if (onScreenshot) {
                    onScreenshot();
                }
            }

            if (i < totalPages) {
                // await page.mouse.click(nextPage.x, nextPage.y);
                await page.evaluate(() => {
                    GR.UI.view.rules_menu.down.click();
                });
                await page.waitForTimeout(50);
            }
        }

        const hasNextMode = m < modes.length - 1;

        if (hasNextMode) {
            // await page.mouse.click(nextPage.x, nextPage.y);
            await page.evaluate(() => {
                GR.UI.view.rules_menu.down.click();
            });
            await page.waitForTimeout(50);
        }
    }

    // await page.close();
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

    // const workersCount = Math.min(config.workers || 1, 3);
    const workersCount = Math.min(
        config.workers || 1,
        4,
        config.langs.length
    );

    const langs = config.langs || ['en'];

    const modes = config.mode === 'both'
        ? ['landscape', 'portrait']
        : [config.mode];

    const chunks = chunkArray(langs, workersCount);

    // status.total = langs.length * modes.length;
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

        totalTasks += effectivePages * modes.length;

        // if (config.screenshotStartScreen) totalTasks += modes.length;
        if (config.screenshotStartScreen) totalTasks += modes.length * 3;
    }

    status.total = totalTasks;

    let completedTasks = 0;
    let finishedWorkers = 0;
    // console.log('RUNJOB START');
    await Promise.all(
        chunks.map(async (chunk, workerId) => {

            const browser = await chromium.launch({
                channel: 'chrome',
                // channel: config.headless ? 'chrome' : undefined,
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
                        modes,
                        pagesCount: config.pagesCount,
                        selectedPages: config.pages,
                        status,
                        enSocExtra: config.enSocExtra,
                        screenshotStartScreen: config.screenshotStartScreen,
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
                // browser.close().catch(console.error);
                await Promise.race([
                    browser.close(),
                    new Promise(res => setTimeout(res, 3000))
                ]).catch(console.error);
                finishedWorkers++;
            }
        })
    );
}

module.exports = { runJob };