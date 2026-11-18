// Keeping the Cloudflare Access session, so a QA does not have to copy cookies.
//
// Access hands out a CF_Authorization cookie after SSO and it lives 24h. The tool
// cannot do SSO itself (SAML + DUO), but it can open a real browser window, let
// the person sign in once, and keep the resulting cookies in a file. Every run
// after that loads the file and goes straight to the game.
//
// This is the fallback. A service token (cfAccess.js) needs no sign-in at all and
// never expires; when one is configured it takes priority and none of this runs.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { isAccessLogin } = require('./cfAccess');

const FILE = path.join(__dirname, 'cf-session.json');

// how long to let someone take over SSO + DUO before giving up
const LOGIN_TIMEOUT = 5 * 60 * 1000;

function read() {
    try {
        if (!fs.existsSync(FILE)) return null;
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
        console.error('cf-session.json unreadable:', e.message);
        return null;
    }
}

// The cookie itself carries the expiry, so the tool knows the session is dead
// before a run starts rather than discovering it on language 14 of 27.
function authCookie(state) {
    const cookies = (state && state.cookies) || [];
    return cookies.find(c => /^CF_Authorization$/i.test(c.name)) || null;
}

function status() {
    const state = read();
    if (!state) return { signedIn: false, reason: 'no saved session' };

    const cookie = authCookie(state);
    if (!cookie) return { signedIn: false, reason: 'saved session has no Access cookie' };

    // expires is seconds since epoch; -1 means a session cookie with no expiry
    const expiresAt = cookie.expires > 0 ? cookie.expires * 1000 : null;
    const msLeft = expiresAt ? expiresAt - Date.now() : null;

    if (msLeft !== null && msLeft <= 0) {
        return { signedIn: false, reason: 'session expired', expiresAt };
    }

    return {
        signedIn: true,
        expiresAt,
        minutesLeft: msLeft === null ? null : Math.round(msLeft / 60000)
    };
}

/** Spread into newContext(): loads the saved cookies, or nothing when there are none. */
function sessionOption() {
    return status().signedIn ? { storageState: FILE } : {};
}

function clearSession() {
    try {
        if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
        return true;
    } catch (e) {
        console.error('could not clear session:', e.message);
        return false;
    }
}

/**
 * Open a visible browser, wait for the person to finish SSO, keep the cookies.
 *
 * Done as soon as the page is off the Access login host — no need to sit through
 * a whole game load just to prove the cookie works.
 */
async function signIn(url, onStatus = () => {}) {
    let browser = null;

    try {
        browser = await chromium.launch({ channel: 'chrome', headless: false });
        const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
        const page = await context.newPage();

        onStatus('opening the platform...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

        if (!isAccessLogin(page.url())) {
            // already through — an earlier session in this browser was still good
            onStatus('already signed in');
        } else {
            onStatus('waiting for you to sign in...');
            const started = Date.now();

            while (Date.now() - started < LOGIN_TIMEOUT) {
                if (page.isClosed()) throw new Error('sign-in window was closed');
                if (!isAccessLogin(page.url())) break;
                await page.waitForTimeout(500);
            }

            if (isAccessLogin(page.url())) throw new Error('sign-in timed out after 5 minutes');
        }

        await page.waitForTimeout(1500);   // let Access finish setting its cookies
        await context.storageState({ path: FILE });

        const s = status();
        if (!s.signedIn) throw new Error('signed in, but no Access cookie was stored');

        console.log(`cf session saved${s.minutesLeft ? ` — valid for ~${Math.round(s.minutesLeft / 60)}h` : ''}`);
        return s;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = { status, sessionOption, signIn, clearSession, FILE };
