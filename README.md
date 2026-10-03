# Diktat

**Realtime voice dictation for macOS, Windows and Linux, in any app. Bring your own API key, pay about a dime per hour.**

Press a shortcut, talk, hit <kbd>Enter</kbd>. Your words appear live in a small floating bubble and get pasted wherever your cursor is: Slack, your editor, the browser, a terminal.

<p align="center">
  <img src="docs/screenshot.png" alt="Diktat floating bubble showing a live transcript" width="600">
</p>

## Why

Tools like Wispr Flow or Superwhisper are great, but they're closed source and cost $10–15 a month. Diktat does the core job in roughly 300 lines of plain JavaScript you can read in ten minutes:

- **Cheap.** Defaults to [Soniox](https://soniox.com) real-time speech-to-text at **$0.12 per hour of audio**. Dictating an hour every day costs about $4 a month.
- **Your choice of provider.** Soniox, ElevenLabs or OpenAI. Switch from the menu bar.
- **Live.** You see words while you speak, not after a long upload.
- **Multilingual.** Mixed German and English (or any of 60+ languages) in the same sentence works.
- **Private by design.** No account, no telemetry, no server of ours. Audio goes straight from your Mac to the speech provider.
- **Tiny.** No framework, no bundler, no build step. `main.js`, one HTML file per window, done.

## Features

- Global shortcut (<kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd>, <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd> on Windows/Linux) from anywhere
- Floating bubble with live transcript, recording timer and an audio-level animation
- <kbd>Enter</kbd> inserts at the cursor, <kbd>Esc</kbd> discards
- Restores your previous clipboard after pasting, images included
- Lives in the menu bar / system tray, and can launch at login (macOS, Windows)
- API keys encrypted with the OS keychain (`safeStorage`: Keychain, DPAPI, libsecret)

## Install

Grab the latest installer from [**Releases**](https://github.com/jannesrudnick/diktat/releases/latest).

### macOS

- **Apple Silicon** (M1 and newer): `Diktat-x.y.z-arm64.dmg`
- **Intel**: `Diktat-x.y.z-x64.dmg`

Open it and drag **Diktat** into **Applications**.

> **First launch:** Diktat isn't notarized by Apple (yet), so macOS blocks it the first time. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Or run once in Terminal:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/Diktat.app
> ```

Grant **Microphone** and **Accessibility** when asked (*System Settings → Privacy & Security*). Accessibility lets Diktat press <kbd>⌘</kbd><kbd>V</kbd> for you. Without it, the transcript still ends up in your clipboard.

### Windows

Run `Diktat-x.y.z-x64.exe`. It installs for your user only, no admin needed.

> **SmartScreen:** the installer isn't code-signed, so Windows may warn you. Click **More info → Run anyway**.

### Linux

- **AppImage** (any distro): `chmod +x Diktat-x.y.z-x86_64.AppImage`, then run it
- **Debian / Ubuntu**: `sudo apt install ./Diktat-x.y.z-amd64.deb`

To paste automatically, install `xdotool` (X11) or `wtype` (Wayland, wlroots compositors like Sway or Hyprland):

```bash
sudo apt install xdotool
```

GNOME and KDE on Wayland don't let apps send keystrokes, so the text lands in your clipboard and you press <kbd>Ctrl</kbd><kbd>V</kbd> yourself. The global shortcut on Wayland goes through the desktop portal, which may ask you to confirm it once.

### From source

Requires Node.js 22+ and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/jannesrudnick/diktat.git
cd diktat
pnpm install
pnpm start
```

`pnpm dist` builds installers for your current OS into `dist/`.

## Setup

1. **Pick a provider** and get an API key (see [Providers](#providers)).
2. **Paste it** into the window that opens on first launch. You can change it later via the tray icon → *API-Keys…*.

> When running via `pnpm start` on macOS, the permission entries are named **Electron**, not Diktat.

## Usage

| Action | Key |
|---|---|
| Start dictating | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd> (macOS) · <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd> (Windows/Linux) |
| Stop and paste at the cursor | <kbd>Enter</kbd> (or the shortcut again, or click **Einfügen**) |
| Discard | <kbd>Esc</kbd> (or click ✕) |

While the bubble is open, <kbd>Enter</kbd> and <kbd>Esc</kbd> are captured system-wide, so they won't reach the app behind it.

## Providers

| Provider | Model | Price | Get a key |
|---|---|---|---|
| **Soniox** (default) | `stt-rt-v5` | $0.12 / hour | [console.soniox.com](https://console.soniox.com) |
| **ElevenLabs** | `scribe_v2_realtime` | $0.39 / hour | [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) |
| **OpenAI** | `gpt-live-transcribe` | $1.02 / hour | [platform.openai.com](https://platform.openai.com/api-keys) |

Switch any time via the tray icon → *Provider*. Keys are stored per provider. Prices are pay-as-you-go list prices at the time of writing.

Adding a provider is one object in `providers.js` with a `connect(key, on)` function: stream audio in, call `on.text()` / `on.done()` / `on.error()`.

## How it works

```
 ⌘⇧Space ──▶ main.js ──show──▶ pill.html (floating, never takes focus)
                                   │  getUserMedia → AudioWorklet (16 kHz Float32)
                                   ▼
                  providers.js → Soniox / ElevenLabs / OpenAI ──▶ live text
 Enter ─────▶ main.js ◀──final text── pill.html
                 │
                 └─ clipboard ← text, simulated paste, clipboard ← previous contents
                    (osascript on macOS, PowerShell SendKeys on Windows, xdotool/wtype on Linux)
```

The bubble window is created with `focusable: false`, so the app you were typing in keeps focus the whole time. That's why a plain simulated paste shortcut lands in the right place.

| File | Purpose |
|---|---|
| `main.js` | Shortcuts, menu-bar icon, window placement, key storage, paste |
| `pill.html` | Bubble UI, microphone capture |
| `providers.js` | One WebSocket adapter per speech-to-text provider |
| `settings.html` | Provider and API key input |
| `preload.js` | Minimal IPC bridge |

## Configuration

There's no settings UI beyond the API key yet. Edit the constants directly:

| What | Where |
|---|---|
| Shortcut | `SHORTCUT` in `main.js` ([accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator)) |
| Languages (Soniox) | `LANGUAGES` in `providers.js` (default `['de', 'en']`). ElevenLabs and OpenAI auto-detect. |
| Models | `model` / `model_id` per provider in `providers.js` |

## Privacy

- Audio is streamed **only while the bubble is visible**, and only to the provider you picked ([Soniox](https://soniox.com/policies), [ElevenLabs](https://elevenlabs.io/privacy-policy), [OpenAI](https://openai.com/policies/privacy-policy)).
- Nothing is stored on disk except your encrypted API keys in the app's data folder (`~/Library/Application Support/Diktat` on macOS, `%APPDATA%\Diktat` on Windows, `~/.config/Diktat` on Linux; lowercase `diktat` when run from source). On Linux without a keyring, they're stored unencrypted.
- No analytics, no update pings, no third-party scripts.

## Troubleshooting

| Problem | Fix |
|---|---|
| Text isn't pasted | **macOS:** grant **Accessibility** to Diktat / Electron, then restart the app. **Linux:** install `xdotool` / `wtype`. The text is in your clipboard meanwhile. |
| "Kein Mikrofonzugriff" | Grant **Microphone** permission. |
| "Incorrect API key" / "Invalid API key" | Re-enter the key via 🎙 → *API-Keys…*. |
| Shortcut does nothing | Another app owns it. Change `SHORTCUT` in `main.js`. |

## Roadmap

Ideas, not promises. PRs are welcome:

- [ ] More providers (Deepgram, AssemblyAI)
- [ ] Settings UI for shortcut, languages and provider
- [ ] Optional LLM clean-up pass (remove filler words, fix punctuation)
- [ ] Push-to-talk (hold to speak)
- [ ] Signed and notarized releases
- [ ] arm64 builds for Windows and Linux

## Alternatives

If Diktat isn't for you, these might be:

- [OpenWhispr](https://github.com/OpenWhispr/openwhispr): open source, Electron, more features
- [VoiceInk](https://github.com/Beingpax/VoiceInk), [Handy](https://github.com/cjpais/Handy): open source, fully local Whisper (no live text)
- Wispr Flow, Superwhisper, Aqua Voice: polished commercial apps
- Built-in dictation: macOS (press <kbd>Fn</kbd> twice), Windows (<kbd>Win</kbd><kbd>H</kbd>)

## Contributing

Issues and PRs welcome. The codebase is intentionally small, so please keep it that way: no frameworks, and no new dependencies without a good reason.

```bash
pnpm install && pnpm start
```

## License

[MIT](LICENSE)
