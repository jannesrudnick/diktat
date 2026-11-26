const { shell, app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, safeStorage, systemPreferences, nativeImage, session } = require('electron')
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

// Every transcript is logged, so nothing is lost when the paste lands in the wrong place (or nowhere).
// Plain text, one "[YYYY-MM-DD HH:MM:SS] text" line per entry.
const historyFile = () => path.join(app.getPath('userData'), 'verlauf.txt')
const stamp = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ')
// Newlines (speaker turns) are escaped as \\n so each entry stays on one line.
const logTranscript = (text) => fs.appendFileSync(historyFile(), `[${stamp(new Date())}] ${text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}\n`)
const unescape = (t) => t.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c))
function recentTranscripts(n = 10) {
  let lines = []
  try { lines = fs.readFileSync(historyFile(), 'utf8').trimEnd().split('\n') } catch {}
  return lines.slice(-n).reverse().map((l) => l.match(/^\[([^\]]+)\] (.*)$/)).filter(Boolean).map(([, time, text]) => ({ time, text: unescape(text) }))
}

let pill, settings, tray, recording = false, appActive = false

// Where the user dragged the pill last; default is bottom center of the display with the cursor.
// A saved spot whose display is gone (unplugged monitor) falls back to the default.
function place() {
  const { width, height } = SIZE
  const saved = loadConfig().pillPos
  if (saved && screen.getAllDisplays().some(({ bounds: b }) => saved.x + width / 2 >= b.x && saved.x + width / 2 < b.x + b.width && saved.y + height / 2 >= b.y && saved.y + height / 2 < b.y + b.height)) {
    return pill.setBounds({ width, height, ...saved })
  }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  pill.setBounds({ width, height, x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 8 })
}

// Join every Space, including fullscreen apps, above their content. macOS drops this after hide(),
// so it's reapplied before every show. skipTransformProcessType: we're a UI element (no dock icon) anyway,
// so don't let Electron flip the process type (which makes the dock icon flash).
function floatOverEverything() {
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  pill.setAlwaysOnTop(true, 'screen-saver', 1)
}

function createPill() {
  pill = new BrowserWindow({
    ...SIZE, frame: false, transparent: true, resizable: false, focusable: false, hasShadow: false,
    // macOS: a fullscreenable window gets FullScreenPrimary, which conflicts with the FullScreenAuxiliary
    // behavior needed to float over other apps' fullscreen spaces.
    fullscreenable: false,
    // macOS: a non-activating panel, so clicking "Einfügen" doesn't pull focus away from the target app.
    ...(process.platform === 'darwin' && { type: 'panel' }),
    skipTaskbar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  floatOverEverything()
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
  floatOverEverything()
  pill.showInactive()
  // As a user gesture, since getDisplayMedia (system audio) requires one.
  pill.webContents.executeJavaScript('start()', true).catch(console.error)
}

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
// The text stays in the clipboard afterwards, so it can be pasted again.
async function paste(text) {
  // Safety net: if Diktat got activated anyway, hand focus back to the previous app first.
  if (appActive && !settings?.isFocused()) { app.hide(); await new Promise((r) => setTimeout(r, 150)) }
  await clipboard.writeText(text)
  execFile(...PASTE, { windowsHide: true }, (err) => err && console.error(`Paste via ${PASTE[0]} failed – text stays in clipboard`, err.message))
}

ipcMain.handle('get-config', () => { const c = loadConfig(); return { provider: c.provider, key: c.keys[c.provider] || '', systemAudio: Boolean(c.systemAudio) } })
ipcMain.handle('get-settings', () => ({ ...loadConfig(), providers: PROVIDERS }))
ipcMain.handle('save-settings', (_, provider, key) => {
  const c = loadConfig()
  saveConfig({ ...c, provider, keys: { ...c.keys, [provider]: key.trim() } })
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
  pill.hide()
  if (!text) return
  try { logTranscript(text) } catch (e) { console.error('Could not write transcript log', e.message) }
  tray.setContextMenu(trayMenu())
  paste(text)
})
ipcMain.on('mouse', (_, over) => pill.setIgnoreMouseEvents(!over, { forward: true }))
// Drag handle: renderer sends screen-space deltas, we move the window and remember where it ended up.
ipcMain.on('move', (_, dx, dy) => { const [x, y] = pill.getPosition(); pill.setPosition(x + dx, y + dy) })
ipcMain.on('moved', () => { const [x, y] = pill.getPosition(); saveConfig({ ...loadConfig(), pillPos: { x, y } }) })

// Last transcripts; clicking one copies it to the clipboard.
function historyMenu() {
  const recent = recentTranscripts()
  return [
    ...recent.map(({ time, text }) => ({
      label: `${time.slice(11, 16)}  ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`.replace(/\n/g, ' '),
      toolTip: text, click: () => clipboard.writeText(text),
    })),
    recent.length ? { label: 'Klick kopiert in die Zwischenablage', enabled: false } : { label: 'Noch nichts diktiert', enabled: false },
    { type: 'separator' },
    { label: 'Verlauf-Datei öffnen…', click: () => { fs.appendFileSync(historyFile(), ''); shell.openPath(historyFile()) } },
  ]
}

const trayMenu = () => Menu.buildFromTemplate([
  { label: `Diktieren (${SHORTCUT_LABEL}) – nochmal drücken stoppt`, click: toggle },
  { label: 'Provider', submenu: Object.entries(PROVIDERS).map(([id, label]) => ({
    label, type: 'radio', checked: loadConfig().provider === id,
    click: () => { const c = loadConfig(); saveConfig({ ...c, provider: id }); if (!c.keys[id]) openSettings() },
  })) },
  { label: 'Systemaudio mitschneiden (Calls)', type: 'checkbox', checked: Boolean(loadConfig().systemAudio),
    click: (i) => saveConfig({ ...loadConfig(), systemAudio: i.checked }) },
  { label: 'Verlauf', submenu: historyMenu() },
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
// macOS: system audio loopback for screen share (ScreenCaptureKit / CoreAudio taps on 14.2+).
if (process.platform === 'darwin') app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacCatapLoopbackAudioForScreenShare')
app.on('did-become-active', () => (appActive = true))
app.on('did-resign-active', () => (appActive = false))

app.whenReady().then(async () => {
  app.dock?.hide()
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }])) // enables ⌘V/⌘C/⌘A in inputs
  await systemPreferences.askForMediaAccess?.('microphone')
  // System audio: getDisplayMedia in the pill gets loopback audio without a picker. Video is mandatory,
  // so we hand it the pill's own frame (dropped right away) instead of a screen: no Screen Recording
  // permission. macOS (CoreAudio tap) only asks for "System Audio Recording" once.
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => cb({ video: req.frame, audio: 'loopback' }))
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
