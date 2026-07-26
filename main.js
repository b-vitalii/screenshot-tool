const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
require('./server');
const fs = require("fs");

let updateWindow = null;

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 1000
    });

    win.loadURL('http://localhost:3000');
}

function showUpdateWindow(version) {
    // don't open twice
    if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.focus();
        return;
    }

    updateWindow = new BrowserWindow({
        width: 560,
        height: 640,
        resizable: false,
        minimizable: false,
        maximizable: false,
        title: 'Доступне оновлення',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    updateWindow.loadFile(path.join(__dirname, 'update-window.html'));

    updateWindow.webContents.on('did-finish-load', () => {
        updateWindow.webContents.send('update-version', version);
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
    autoUpdater.checkForUpdatesAndNotify();
});