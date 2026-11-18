// Cloudflare Access sits in front of the game platform: a browser with no
// CF_Authorization cookie is redirected to an SSO login instead of the game.
// Playwright always starts from a clean profile, so every run hits that wall.
//
// The sanctioned way past it for automation is a service token — two headers
// that Cloudflare accepts in place of a login. The token has to be allowed on
// the platform's Access application by whoever administers Zero Trust.
//
// Looked up, in order: environment, then cf-access.json next to the app.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'cf-access.json');

function readToken() {
    const envId = process.env.CF_ACCESS_CLIENT_ID;
    const envSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    if (envId && envSecret) return { id: envId, secret: envSecret, from: 'env' };

    try {
        if (fs.existsSync(FILE)) {
            const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            if (f && f.clientId && f.clientSecret) {
                return { id: f.clientId, secret: f.clientSecret, from: 'cf-access.json' };
            }
        }
    } catch (e) {
        console.error('cf-access.json unreadable:', e.message);
    }

    return null;
}

/** Headers for newContext({ extraHTTPHeaders }) — empty when no token is set up. */
function accessHeaders() {
    const t = readToken();
    if (!t) return {};
    return {
        'CF-Access-Client-Id': t.id,
        'CF-Access-Client-Secret': t.secret
    };
}

function hasToken() {
    return !!readToken();
}

function tokenSource() {
    const t = readToken();
    return t ? t.from : null;
}

/** True once a navigation has landed on the Access login screen. */
function isAccessLogin(url) {
    return /cloudflareaccess\.com|\/cdn-cgi\/access\/login/i.test(String(url || ''));
}

/** One sentence that says what to do, instead of a bare timeout. */
function accessError(url) {
    return hasToken()
        ? `Cloudflare Access rejected the service token (from ${tokenSource()}) — `
          + `it is probably not allowed on this application. Landed on: ${url}`
        : 'the platform now requires a Cloudflare Access login, and no service token is set up — '
          + 'put CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET in cf-access.json next to the app';
}

module.exports = { accessHeaders, hasToken, tokenSource, isAccessLogin, accessError };
