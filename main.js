const { app, BrowserWindow } = require('electron');
const path = require('path');

require('./server');
const fs = require("fs");

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 1000
    });

    win.loadURL('http://localhost:3000');
}

app.whenReady().then(() => {
    setTimeout(createWindow, 1000);
});
