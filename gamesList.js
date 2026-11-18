const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { accessHeaders, isAccessLogin, accessError } = require('./cfAccess');
const { sessionOption } = require('./cfSession');

// tried in order — the first one that loads wins
const CANDIDATES = ['bell_bang', 'lucky_apple_x2500', '4_fortune_clovers'];

const DEFAULT_EMAIL = 'v.boiko@hraymo.com';

const CACHE_FILE = path.join(__dirname, 'games-cache.json');

const NAV_TIMEOUT = 30000;   // page.goto
const GAMES_TIMEOUT = 30000; // GR.Options.available_games showing up

// The short URL we used to build is NOT what the playground opens. The
// playground appends the whole dev-flag block, and golden_teapot answers
// SERVER_ERROR without it while the same URL with the block attached runs
// fine — same game, same plain token. So build the launch URL the way the
// playground does, flag for flag.
//
// Most of these are deliberately empty: an empty flag means "platform
// default", which is exactly what the playground sends. The four that carry
// a 0 are the ones that help a screenshot run — no idle timeout, no reality
// check, no artificial minimum spin time.
const LAUNCH_PARAMS = {
    allow_http_debug: '',
    dev_min_spin_time: '0',
    dev_min_gs_time: '0',
    reality_check_interval: '0',
    dev_session_idle_timeout: '0',
    quickspin: '',
    dev_quick_spin_default_value: '',
    dev_show_game_name: '',
    dev_allow_autoplay: '',
    dev_disable_autoplay_in_bonus_game: '',
    dev_show_autoplay_menu: '',
    dev_show_autoplay_total_bet_confirmation: '',
    dev_autoplay_menu_loss_limit: '',
    dev_autoplay_menu_single_win_limit: '',
    dev_autoplay_menu_bet_change: '',
    dev_autoplay_menu_rounds: '',
    dev_show_net_position: '',
    dev_show_winnings: '',
    dev_disable_buy_bonus: '',
    dev_allow_gamble: '',
    dev_authenticity_enabled: '',
    dev_show_rtp_in_common_rules: '',
    dev_show_min_max_bet_in_common_rules: '',
    dev_show_button_explanations_in_common_rules: '',
    dev_show_max_exposure_in_common_rules: '',
    dev_show_max_exposure_frequency_in_common_rules: '',
    dev_show_rtp_in_game: '',
    dev_show_persistence_description: '',
    dev_show_time: '',
    dev_show_session_time: '',
    dev_show_paytable_on_start: '',
    dev_allow_paytable_during_spin: '',
    dev_show_demo_mode_in_game: '',
    dev_show_lower_bet_popup: '',
    dev_glory_to_ukraine: '',
    dev_show_compliance_version: '',
    dev_show_additional_math_info: '',
    dev_show_math_changed_error: '',
    dev_show_win_up_to_info: '',
    dev_allow_shop: '',
    dev_disable_spin_on_play: '',
    dev_disable_reel_skipping: '',
    dev_disable_gold_bet: '',
    dev_disable_line_switching: '',
    dev_generate_pt_details: '0',
    dev_allow_freebet_deferred_use: '',
    dev_allow_freebet_rejection: '',
    dev_show_balance_switch_popup_after_freebet: '',
    dev_show_replay_button: '',
    dev_game_client_asset_mode: ''
};

function buildGameUrl(game, email) {
    const mail = (email && String(email).trim()) || DEFAULT_EMAIL;
    const ts = Math.floor(Date.now() / 1000);

    const u = new URL('https://betman.hraymo.team.goreel.tech/betlabel-hraymo/game/');
    const q = u.searchParams;

    q.set('profile', 'default');
    q.set('token', `EUR:${game}-${mail}+seamless`);
    q.set('game', game);
    q.set('wl', 'prod');
    q.set('ts', String(ts));
    q.set('title', game);
    q.set('lang', 'en');
    q.set('sound', '');
    q.set('mobile', '1');
    q.set('incognito', '');
    q.set('exit_url', '//betlabel.hraymo.team.goreel.tech');
    q.set('cashier_url', '//betlabel.hraymo.team.goreel.tech/cashier/');

    for (const [k, v] of Object.entries(LAUNCH_PARAMS)) q.set(k, v);

    return u.toString();
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
    const context = await browser.newContext({ extraHTTPHeaders: accessHeaders(), ...sessionOption() });
    const page = await context.newPage();

    try {
        await page.goto(buildGameUrl(game, email), {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT
        });

        if (isAccessLogin(page.url())) throw new Error(accessError(page.url()));

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

const LANGS_TIMEOUT = 40000;

async function readLanguagesFromPage(browser, game, email) {
    const context = await browser.newContext({ extraHTTPHeaders: accessHeaders(), ...sessionOption() });
    const page = await context.newPage();

    try {
        await page.goto(buildGameUrl(game, email), {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT
        });

        if (isAccessLogin(page.url())) throw new Error(accessError(page.url()));

        await page.waitForFunction(() => {
            const i18n = window.GR?.Options?.current_game_manifest?.i18n
                || window.GR?.Options?.options?.i18n;
            return !!(i18n && Object.keys(i18n).length);
        }, { timeout: LANGS_TIMEOUT });

        const langs = await page.evaluate(() => Object.keys(
            window.GR.Options.current_game_manifest?.i18n
            || window.GR.Options.options.i18n
        ));

        return sortGames(langs);   // same dedupe + natural sort
    } finally {
        await context.close().catch(() => {});
    }
}

/** Cached language list for one game, or [] if it has never been fetched. */
function getCachedLanguages(game) {
    const cached = readCache();
    return (cached && cached.languages && cached.languages[game]) || [];
}

/** Every game we know languages for. */
function getCachedLanguageMap() {
    const cached = readCache();
    return (cached && cached.languages) || {};
}

/**
 * Open one game and read the languages it supports, then remember them.
 * Never rejects: a game that will not open returns ok:false and whatever was
 * cached before, so the UI can fall back to showing everything.
 */
async function fetchGameLanguages(game, email) {
    if (!game) return { ok: false, game, languages: [], message: 'No game given' };

    let browser = null;

    try {
        browser = await launchBrowser();

        const languages = await readLanguagesFromPage(browser, game, email);

        if (!languages.length) throw new Error('game exposed an empty language list');

        const payload = readCache() || { games: [] };
        payload.languages = payload.languages || {};
        payload.languages[game] = languages;
        payload.languagesFetchedAt = payload.languagesFetchedAt || {};
        payload.languagesFetchedAt[game] = new Date().toISOString();
        writeCache(payload);

        console.log(`languages: ${game} supports ${languages.length} — ${languages.join(', ')}`);

        return { ok: true, game, languages, cached: false, message: `${languages.length} languages` };
    } catch (e) {
        console.error(`languages: ${game} failed — ${e.message}`);

        const fallback = getCachedLanguages(game);
        return {
            ok: false,
            game,
            languages: fallback,
            cached: true,
            message: e.message
        };
    } finally {
        if (browser) {
            await Promise.race([
                browser.close(),
                new Promise(res => setTimeout(res, 3000))
            ]).catch(() => {});
        }
    }
}

module.exports = {
    buildGameUrl,
    fetchGamesList, getCachedGames, getCacheInfo, CANDIDATES,
    fetchGameLanguages, getCachedLanguages, getCachedLanguageMap
};
