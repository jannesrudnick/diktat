const { shell, app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, ClipboardItem, safeStorage, systemPreferences, nativeImage } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const SHORTCUT = 'CommandOrControl+Shift+Space'
const SHORTCUT_LABEL = process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space'
const SIZE = { width: 600, height: 180 } // transparent canvas for card + dock; click-through outside them

const PROVIDERS = { soniox: 'Soniox', elevenlabs: 'ElevenLabs', openai: 'OpenAI' } // implementations: providers.js

// { provider, keys: { [provider]: apiKey } }, encrypted via OS keychain (Keychain / DPAPI / libsecret).
// Linux without a keyring: stored unencrypted, like most CLI tools store their tokens.
const encrypt = (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s))
const decrypt = (b) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString())
const configFile = () => path.join(app.getPath('userData'), 'config.bin')
function loadConfig() {
  try { return JSON.parse(decrypt(fs.readFileSync(configFile()))) } catch {}
  // v0.1 stored a single Soniox key in key.bin
  try { return { provider: 'soniox', keys: { soniox: decrypt(fs.readFileSync(path.join(app.getPath('userData'), 'key.bin'))) } } } catch {}
  return { provider: 'soniox', keys: {} }
}
const saveConfig = (c) => fs.writeFileSync(configFile(), encrypt(JSON.stringify(c)))
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
  // Linux can't forward mouse moves through ignored windows, so hover would never re-enable clicks there.
  if (process.platform !== 'linux') pill.setIgnoreMouseEvents(true, { forward: true })
  pill.loadFile('pill.html')
}

function openSettings() {
  if (settings) return app.focus({ steal: true }), settings.focus()
  settings = new BrowserWindow({ width: 420, height: 260, resizable: false, show: false, title: 'Diktat', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js') } })
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

// Simulated paste shortcut, per platform.
const wayland = Boolean(process.env.WAYLAND_DISPLAY)
const PASTE = {
  // Needs Accessibility permission (System Settings → Privacy & Security → Accessibility).
  darwin: ['osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']],
  win32: ['powershell', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"]],
  // X11: xdotool. Wayland: wtype (wlroots compositors; GNOME/KDE Wayland don't allow synthetic input this way).
  linux: wayland ? ['wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']] : ['xdotool', ['key', '--clearmodifiers', 'ctrl+v']],
}[process.platform]

// Paste into whatever app has focus (pill is non-focusable, so focus never left it).
async function paste(text) {
  const prev = await snapshotClipboard().catch(() => [])
  await clipboard.writeText(text)
  execFile(...PASTE, { windowsHide: true }, (err) => {
    if (err) return console.error(`Paste via ${PASTE[0]} failed – text stays in clipboard`, err.message)
    setTimeout(() => prev.length && clipboard.write(prev).catch(console.error), 500)
  })
}

ipcMain.handle('get-config', () => { const c = loadConfig(); return { provider: c.provider, key: c.keys[c.provider] || '' } })
ipcMain.handle('get-settings', () => ({ ...loadConfig(), providers: PROVIDERS }))
ipcMain.handle('save-settings', (_, provider, key) => {
  const c = loadConfig()
  saveConfig({ provider, keys: { ...c.keys, [provider]: key.trim() } })
  tray.setContextMenu(trayMenu())
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

const trayMenu = () => Menu.buildFromTemplate([
  { label: `Diktieren (${SHORTCUT_LABEL}) – Enter fügt ein, Esc verwirft`, click: toggle },
  { label: 'Provider', submenu: Object.entries(PROVIDERS).map(([id, label]) => ({
    label, type: 'radio', checked: loadConfig().provider === id,
    click: () => { const c = loadConfig(); saveConfig({ ...c, provider: id }); if (!c.keys[id]) openSettings() },
  })) },
  { label: 'API-Keys…', click: openSettings },
  // Electron has no login-item API on Linux; use the desktop's autostart settings there.
  ...(process.platform === 'linux' ? [] : [{ label: 'Beim Login starten', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
    click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) }]),
  { type: 'separator' },
  { label: 'Beenden', role: 'quit' },
])

if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', openSettings)
// Wayland: global shortcuts only work through the desktop portal.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

app.whenReady().then(async () => {
  app.dock?.hide()
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }])) // enables ⌘V/⌘C/⌘A in inputs
  await systemPreferences.askForMediaAccess?.('microphone')
  createPill()
  if (!globalShortcut.register(SHORTCUT, toggle)) console.error(`Shortcut ${SHORTCUT} already taken`)

  // macOS: monochrome template image that follows the menu bar's light/dark look.
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')))
  tray.setToolTip('Diktat')
  tray.setContextMenu(trayMenu()) // Linux (AppIndicator) only supports a context menu, no click events

  if (!activeKey()) openSettings()
})

app.on('window-all-closed', (e) => e.preventDefault())
app.on('will-quit', () => globalShortcut.unregisterAll())
