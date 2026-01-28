const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const isDev = !app.isPackaged;

let mainWindow;
let tray;

function createTray() {
    const iconPath = path.resolve(__dirname, 'icon.png');
    console.log('--- Tray Initialization ---');
    console.log('Icon path:', iconPath);

    let icon = nativeImage.createFromPath(iconPath);

    if (icon.isEmpty()) {
        console.error('ERROR: Tray icon is empty! Electron could not load the image.');
        // Fallback to empty icon so it doesn't crash
        icon = nativeImage.createEmpty();
    } else {
        console.log('SUCCESS: Tray icon loaded.');
    }

    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show App', click: () => {
                mainWindow.show();
            }
        },
        {
            label: 'Exit', click: () => {
                app.isQuitting = true;
                app.quit();
            }
        },
    ]);
    tray.setToolTip('dbMeterWin');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        show: false,
        title: 'Decibel Meter Pro',
        backgroundColor: '#0f172a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (isDev) mainWindow.webContents.openDevTools();
    });

    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });
}

ipcMain.on('show-window', () => {
    if (mainWindow) {
        mainWindow.show();
    }
});

ipcMain.on('notify', (event, { title, body }) => {
    console.log('IPC: Received notification request:', { title, body });
    if (Notification.isSupported()) {
        console.log('Notification API is supported');
        const notify = new Notification({
            title,
            body,
            icon: path.join(__dirname, 'icon.png'),
            silent: false,
        });
        notify.show();
        notify.on('show', () => console.log('Notification shown on screen'));
        notify.on('click', () => {
            console.log('Notification clicked');
            if (mainWindow) mainWindow.show();
        });
        notify.on('failed', (e, error) => console.error('Notification failed:', error));
    } else {
        console.error('Notification API is NOT supported on this system');
    }
});

ipcMain.on('export-logs', async (event, logs) => {
    if (!logs || logs.length === 0) return;

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Noise Logs',
        defaultPath: path.join(app.getPath('documents'), 'noise-logs.csv'),
        filters: [
            { name: 'CSV Files', extensions: ['csv'] }
        ]
    });

    if (filePath) {
        try {
            const header = 'Timestamp,Level (dB),Description\n';
            const rows = logs.map(l => `"${l.timestamp}",${l.db},"${l.label}"`).join('\n');
            fs.writeFileSync(filePath, header + rows, 'utf-8');
            console.log('Logs exported successfully to:', filePath);
        } catch (err) {
            console.error('Failed to export logs:', err);
        }
    }
});

app.whenReady().then(() => {
    if (process.platform === 'win32') {
        app.setAppUserModelId('com.dbmeter.win');
    }
    createWindow();
    createTray();

    // Test notification on startup
    if (Notification.isSupported()) {
        const startNotify = new Notification({
            title: 'dB Meter started',
            body: 'App is ready to measure sound.',
            icon: path.join(__dirname, 'icon.png')
        });
        startNotify.show();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
