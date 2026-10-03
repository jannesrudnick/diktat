const { shell, app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, ClipboardItem, safeStorage, systemPreferences, nativeImage } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const SHORTCUT = 'CommandOrControl+Shift+Space'
const SIZE = { width: 600, height: 180 } // transparent canvas for card + dock; click-through outside them

const PROVIDERS = { soniox: 'Soniox', elevenlabs: 'ElevenLabs', openai: 'OpenAI' } // implementations: providers.js

// { provider, keys: { [provider]: apiKey } }, encrypted with the macOS Keychain.
const configFile = () => path.join(app.getPath('userData'), 'config.bin')
function loadConfig() {
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(configFile()))) } catch {}
  // v0.1 stored a single Soniox key in key.bin
  try { return { provider: 'soniox', keys: { soniox: safeStorage.decryptString(fs.readFileSync(path.join(app.getPath('userData'), 'key.bin'))) } } } catch {}
  return { provider: 'soniox', keys: {} }
}
const saveConfig = (c) => fs.writeFileSync(configFile(), safeStorage.encryptString(JSON.stringify(c)))
const activeKey = () => { const c = loadConfig(); return c.keys[c.provider] || '' }

let pill, settings, tray, recording = false

function place() {
  const { width, height } = SIZE
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  pill.setBounds({ width, height, x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 8 })
}

function createPill() {
  pill = new BrowserWindow({
    ...SIZE, frame: false, transparent: true, resizable: false, focusable: false, hasShadow: false,
    skipTaskbar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  pill.setIgnoreMouseEvents(true, { forward: true })
  pill.loadFile('pill.html')
}

function openSettings() {
  if (settings) return app.focus({ steal: true }), settings.focus()
  settings = new BrowserWindow({ width: 420, height: 220, resizable: false, show: false, title: 'Diktat', webPreferences: { preload: path.join(__dirname, 'preload.js') } })
  settings.loadFile('settings.html')
  settings.webContents.setWindowOpenHandler(({ url }) => (shell.openExternal(url), { action: 'deny' }))
  settings.on('closed', () => (settings = null))
  // Dock-less apps don't get keyboard focus unless we activate explicitly once the window exists.
  settings.once('ready-to-show', () => { app.focus({ steal: true }); settings.show(); settings.focus() })
}

function toggle() {
  if (!activeKey()) return openSettings()
  if (recording) return pill.webContents.send('stop')
  recording = true
  place()
  pill.showInactive()
  // Only while recording: Enter inserts, Esc discards (swallowed system-wide meanwhile).
  globalShortcut.register('Return', () => pill.webContents.send('stop'))
  globalShortcut.register('Escape', () => pill.webContents.send('cancel'))
  pill.webContents.send('start')
}

// Electron ≥44 clipboard is async (web-style). Items from read() must be rebuilt before write().
const snapshotClipboard = async () => Promise.all((await clipboard.read()).map(async (i) =>
  new ClipboardItem(Object.fromEntries(await Promise.all(i.types.map(async (t) => [t, await i.getType(t)]))))))

// Paste into whatever app has focus (pill is non-focusable, so focus never left it).
// Needs Accessibility permission (System Settings → Privacy & Security → Accessibility).
async function paste(text) {
  const prev = await snapshotClipboard().catch(() => [])
  await clipboard.writeText(text)
  execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], (err) => {
    if (err) return console.error('Paste failed (Accessibility permission?) – text stays in clipboard', err.message)
    setTimeout(() => prev.length && clipboard.write(prev).catch(console.error), 500)
  })
}

ipcMain.handle('get-config', () => { const c = loadConfig(); return { provider: c.provider, key: c.keys[c.provider] || '' } })
ipcMain.handle('get-settings', () => ({ ...loadConfig(), providers: PROVIDERS }))
ipcMain.handle('save-settings', (_, provider, key) => {
  const c = loadConfig()
  saveConfig({ provider, keys: { ...c.keys, [provider]: key.trim() } })
  settings?.close()
})
// ElevenLabs realtime only accepts the API key as a header, which browser WebSockets can't send.
ipcMain.handle('eleven-token', async () => {
  const res = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
    method: 'POST', headers: { 'xi-api-key': loadConfig().keys.elevenlabs || '' },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.detail?.message || `HTTP ${res.status}`)
  return body.token
})
ipcMain.on('done', (_, text) => {
  recording = false
  globalShortcut.unregister('Return')
  globalShortcut.unregister('Escape')
  pill.hide()
  if (text) paste(text)
})
ipcMain.on('mouse', (_, over) => pill.setIgnoreMouseEvents(!over, { forward: true }))

app.whenReady().then(async () => {
  app.dock?.hide()
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }])) // enables ⌘V/⌘C/⌘A in inputs
  await systemPreferences.askForMediaAccess?.('microphone')
  createPill()
  if (!globalShortcut.register(SHORTCUT, toggle)) console.error(`Shortcut ${SHORTCUT} already taken`)

  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('🎙')
  const menu = () => Menu.buildFromTemplate([
    { label: `Diktieren (${SHORTCUT}) – Enter fügt ein, Esc verwirft`, click: toggle },
    { label: 'Provider', submenu: Object.entries(PROVIDERS).map(([id, label]) => ({
      label, type: 'radio', checked: loadConfig().provider === id,
      click: () => { const c = loadConfig(); saveConfig({ ...c, provider: id }); if (!c.keys[id]) openSettings() },
    })) },
    { label: 'API-Keys…', click: openSettings },
    { label: 'Beim Login starten', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Beenden', role: 'quit' },
  ])
  tray.on('click', () => tray.popUpContextMenu(menu()))

  if (!activeKey()) openSettings()
})

app.on('window-all-closed', (e) => e.preventDefault())
app.on('will-quit', () => globalShortcut.unregisterAll())
