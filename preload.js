const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (provider, key) => ipcRenderer.invoke('save-settings', provider, key),
  elevenToken: () => ipcRenderer.invoke('eleven-token'),
  done: (text) => ipcRenderer.send('done', text),
  mouse: (over) => ipcRenderer.send('mouse', over),
  on: (ch, fn) => ipcRenderer.on(ch, () => fn()),
})
