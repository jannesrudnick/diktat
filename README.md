# Diktat

Tiny floating dictation bubble for macOS. Press a shortcut, talk, hit Enter — the text lands in whatever app you're in. Realtime transcription via [Soniox](https://soniox.com) (~$0.12 per hour of audio).

## Usage

1. `pnpm install && pnpm start` (or `pnpm dist` → `dist/Diktat-*.dmg`)
2. Paste your Soniox API key (from [console.soniox.com](https://console.soniox.com)) — stored encrypted via macOS Keychain.
3. `⌘⇧Space` shows the bubble and starts recording. `Enter` (or `⌘⇧Space` again) stops and pastes into the focused app, `Esc` discards.

Grant **Microphone** and **Accessibility** (for auto-paste) when macOS asks: System Settings → Privacy & Security.

Menu bar 🎙 → change key, launch at login, quit.

## License

MIT
