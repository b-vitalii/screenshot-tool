const { app, BrowserWindow, dialog } = require('electron');
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

autoUpdater.on('update-available', () => {
    dialog.showMessageBox({
        title: 'Оновлення',
        message: 'Доступна нова версія. Завантажую...'
    });
});

autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
        title: 'Оновлення готове',
        message: 'Оновлення завантажено. Натисни OK щоб перезапустити.',
        buttons: ['OK']
    }).then(() => {
        autoUpdater.quitAndInstall();
    });
});

autoUpdater.on('error', (err) => {
    console.error('AutoUpdater error:', err);
});

app.whenReady().then(() => {
    setTimeout(createWindow, 1000);
    autoUpdater.checkForUpdatesAndNotify();
});