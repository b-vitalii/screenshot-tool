const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// tried in order — the first one that loads wins
const CANDIDATES = ['bell_bang', 'lucky_apple_x2500', '4_fortune_clovers'];

const DEFAULT_EMAIL = 'v.boiko@hraymo.com';

const CACHE_FILE = path.join(__dirname, 'games-cache.json');

const NAV_TIMEOUT = 30000;   // page.goto
const GAMES_TIMEOUT = 30000; // GR.Options.available_games showing up

function buildGameUrl(game, email) {
    const mail = (email && String(email).trim()) || DEFAULT_EMAIL;
    const ts = Math.floor(Date.now() / 1000);
    const token = encodeURIComponent(`EUR:${game}-${mail}+seamless`);

    return `https://betman.hraymo.team.goreel.tech/betlabel-hraymo/game/`
        + `?profile=default&token=${token}&game=${game}&wl=prod&ts=${ts}`
        + `&title=${game}&lang=en&sound=&mobile=1&incognito=`
        + `&exit_url=%2F%2Fbetlabel.hraymo.team.goreel.tech`
        + `&cashier_url=%2F%2Fbetlabel.hraymo.team.goreel.tech%2Fcashier%2F`;
}

// ── cache ───────────────────────────────────────────────────────────────────

function readCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (Array.isArray(data)) return { games: data };              // old shape
        if (data && Array.isArray(data.games)) return data;
        return null;
    } catch (e) {
        console.error('games cache read failed:', e.message);
        return null;
    }
}

function writeCache(payload) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('games cache write failed:', e.message);
    }
}

function getCachedGames() {
    const cached = readCache();
    return (cached && cached.games) || [];
}

function getCacheInfo() {
    return readCache();
}

function sortGames(list) {
    return Array.from(new Set(list.filter(g => typeof g === 'string' && g.trim())))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

const LAUNCH_ARGS = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox'];

async function launchBrowser() {
    try {
        return await chromium.launch({ channel: 'chrome', headless: true, args: LAUNCH_ARGS });
    } catch (e) {
        console.error('games list: chrome channel unavailable, falling back to bundled chromium —', e.message.split('\n')[0]);
        return await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    }
}

async function readGamesFromCandidate(browser, game, email) {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto(buildGameUrl(game, email), {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT
        });

        await page.waitForFunction(() => {
            const g = window.GR;
            return !!(g && g.Options && g.Options.available_games
                && Object.keys(g.Options.available_games).length);
        }, { timeout: GAMES_TIMEOUT });

        const games = await page.evaluate(() => Object.keys(window.GR.Options.available_games));

        return sortGames(games);
    } finally {
        await context.close().catch(() => {});
    }
}

async function fetchGamesList(email) {
    const attempts = [];
    let browser = null;

    try {
        browser = await launchBrowser();

        for (const game of CANDIDATES) {
            try {
                console.log(`games list: trying ${game}...`);
                const games = await readGamesFromCandidate(browser, game, email);

                if (!games.length) throw new Error('game returned an empty catalogue');

                const payload = {
                    games,
                    source: game,
                    fetchedAt: new Date().toISOString()
                };
                writeCache(payload);

                console.log(`games list: got ${games.length} game(s) from ${game}`);

                return {
                    ok: true,
                    games,
                    source: game,
                    cached: false,
                    message: `Got ${games.length} games`
                };
            } catch (e) {
                console.error(`games list: ${game} failed — ${e.message}`);
                attempts.push(`${game}: ${e.message}`);
            }
        }
    } catch (e) {
        console.error('games list: browser launch failed —', e.message);
        attempts.push(`browser: ${e.message}`);
    } finally {
        if (browser) {
            await Promise.race([
                browser.close(),
                new Promise(res => setTimeout(res, 3000))
            ]).catch(() => {});
        }
    }

    const fallback = getCachedGames();

    return {
        ok: false,
        games: fallback,
        source: null,
        cached: true,
        message: fallback.length
            ? `Could not reach any game — keeping the previous ${fallback.length} games`
            : 'Could not reach any game',
        attempts
    };
}

module.exports = { fetchGamesList, getCachedGames, getCacheInfo, CANDIDATES };
