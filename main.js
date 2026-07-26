const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
require('./server');
const fs = require("fs");

let updateWindow = null;
let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 1000
    });

    mainWindow.loadURL('http://localhost:3000');

    // check for updates only after the main window is ready & shown
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            autoUpdater.checkForUpdatesAndNotify();
        }, 1500);
    });
}

function showUpdateWindow(version) {
    // don't open twice
    if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.focus();
        return;
    }

    updateWindow = new BrowserWindow({
        width: 560,
        height: 760,
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