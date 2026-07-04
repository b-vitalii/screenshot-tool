const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
require('./server');
const fs = require("fs");

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 1000
    });

    win.loadURL('http://localhost:3000');
}

autoUpdater.autoDownload = false; // ← не завантажувати

autoUpdater.on('update-available', () => {
    dialog.showMessageBox({
        title: 'Доступне оновлення',
        message: 'Нова версія доступна! Перейди на GitHub щоб скачати.',
        buttons: ['Відкрити GitHub', 'Пізніше']
    }).then((result) => {
        if (result.response === 0) {
            shell.openExternal('https://github.com/b-vitalii/screenshot-tool/releases/latest');
        }
    });
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