const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    sendNotification: (title, body) => {
        ipcRenderer.send('notify', { title, body });
    },
    showWindow: () => ipcRenderer.send('show-window'),
    exportLogs: (logs) => ipcRenderer.send('export-logs', logs)
});
