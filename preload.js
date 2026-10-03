const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getKey: () => ipcRenderer.invoke('get-key'),
  setKey: (k) => ipcRenderer.invoke('set-key', k),
  done: (text) => ipcRenderer.send('done', text),
  mouse: (over) => ipcRenderer.send('mouse', over),
  on: (ch, fn) => ipcRenderer.on(ch, () => fn()),
})
