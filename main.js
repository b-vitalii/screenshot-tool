const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const server = require('./server');
const fs = require("fs");
const { spawn } = require('child_process');

let updateWindow = null;
let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 1000,
        webPreferences: {
            // A minimised window is a hidden page, and Chromium throttles hidden
            // pages: the 300 ms /status poll drops to ~1/s and can stall entirely.
            // That is why the "run finished" feedback used to appear only after the
            // window was brought back. Nothing else here is changed — node stays
            // out of the renderer.
            backgroundThrottling: false
        }
    });

    mainWindow.loadURL('http://localhost:3000');

    // you have seen it — drop the badge and stop the bouncing
    mainWindow.on('focus', clearRunSignal);
    mainWindow.on('restore', clearRunSignal);
    mainWindow.on('show', clearRunSignal);

    // check for updates only after the main window is ready & shown
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            autoUpdater.checkForUpdatesAndNotify();
        }, 1500);
    });
}

// ── "run finished" signal ───────────────────────────────────────────────────
//
// A native OS notification is not an option here: macOS only emits notification
// events for code-signed apps, and this build is unsigned. So the signal is done
// with things that need no signature and no permission at all — a dock badge, a
// bouncing icon on macOS, a flashing taskbar button on Windows, and a sound.
//
// The sound is played from HERE, not from the page. The page is the one thing that
// is asleep exactly when the signal matters (window minimised), so a renderer
// chime arrived only after the window came back. afplay/beep does not care.
//
// Everything is wrapped: a failing nicety must never take the app down.
const MAC_SOUNDS = {
    ok: '/System/Library/Sounds/Glass.aiff',
    bad: '/System/Library/Sounds/Basso.aiff'
};

function playSignalSound(bad) {
    try {
        const file = bad ? MAC_SOUNDS.bad : MAC_SOUNDS.ok;
        if (process.platform === 'darwin' && fs.existsSync(file)) {
            const p = spawn('afplay', [file], { detached: true, stdio: 'ignore' });
            p.on('error', () => { try { shell.beep(); } catch (e) {} });
            p.unref();
            return;
        }
        shell.beep();   // Windows / Linux: the system sound, whatever it is
    } catch (e) { /* no sound, no problem */ }
}

function signalRunFinished({ ok, findings, cancelled }) {
    try {
        const isMac = process.platform === 'darwin';

        if (cancelled) {
            clearRunSignal();
            return;
        }

        playSignalSound(!ok);

        if (isMac && app.dock && app.dock.setBadge) {
            // a string, so a clean run gets a tick instead of no badge at all
            app.dock.setBadge(findings > 0 ? String(findings) : '✓');
        } else if (app.setBadgeCount) {
            app.setBadgeCount(findings > 0 ? findings : 0);
        }

        if (isMac && app.dock && app.dock.bounce) {
            // 'critical' keeps bouncing until the app is brought to the front
            app.dock.bounce('critical');
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
            if (!isMac) mainWindow.setProgressBar(ok ? -1 : 1, { mode: ok ? 'none' : 'error' });
        }
    } catch (e) {
        console.error('run-finished signal failed:', e);
    }
}

function clearRunSignal() {
    try {
        if (process.platform === 'darwin' && app.dock && app.dock.setBadge) app.dock.setBadge('');
        else if (app.setBadgeCount) app.setBadgeCount(0);
        if (process.platform === 'darwin' && app.dock && app.dock.cancelBounce) app.dock.cancelBounce();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.flashFrame(false);
            mainWindow.setProgressBar(-1);
        }
    } catch (e) { /* nothing important */ }
}

if (server && server.events) {
    server.events.on('run-finished', signalRunFinished);
}

function showUpdateWindow(version) {
    // don't open twice
    if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.focus();
        return;
    }

    updateWindow = new BrowserWindow({
        width: 560,
        height: 820,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: 'Update Available',
        parent: mainWindow || undefined,   // attach to main window
        modal: true,                        // block main window until closed/dismissed
        show: false,                        // show only when ready (no flash before content)
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    updateWindow.loadFile(path.join(__dirname, 'update-window.html'));

    updateWindow.webContents.on('did-finish-load', () => {
        updateWindow.webContents.send('update-version', version);
    });

    updateWindow.once('ready-to-show', () => {
        updateWindow.show();
        updateWindow.focus();
    });

    updateWindow.on('closed', () => {
        updateWindow = null;
    });
}

ipcMain.on('close-update-window', () => {
    if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.close();
    }
});

autoUpdater.autoDownload = false; // ← не завантажувати

autoUpdater.on('update-available', (info) => {
    const version = info && info.version ? info.version : '';
    showUpdateWindow(version);
});

autoUpdater.on('error', (err) => {
    console.error('AutoUpdater error:', err);
});

autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
});

autoUpdater.on('update-not-available', () => {
    console.log('Update not available');
});

app.whenReady().then(() => {
    setTimeout(createWindow, 1000);
});