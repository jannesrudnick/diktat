// Realtime speech-to-text providers.
// connect(key, on) streams mic audio and reports back via
//   on.text(final, partial)  – live update
//   on.done(final)           – after end(), once the provider has flushed everything
//   on.error(message)
// and returns { audio(Float32Array), end(), close() }. Audio arrives mono at `rate` Hz.

const LANGUAGES = ['de', 'en']

// WebSocket that queues messages until the socket is open (and its config is sent).
function socket(url, protocols, handlers) {
  let ws, queue = [], closed = false
  Promise.resolve(url).then((u) => {
    if (closed) return
    ws = new WebSocket(u, protocols)
    ws.onopen = () => { handlers.open?.(ws); queue.forEach((m) => ws.send(m)); queue = null }
    ws.onmessage = ({ data }) => handlers.message(JSON.parse(data))
    ws.onerror = () => handlers.error('Verbindung fehlgeschlagen')
  }, (e) => handlers.error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  return {
    send: (m) => (queue ? queue.push(m) : ws.readyState === 1 && ws.send(m)),
    close: () => { closed = true; ws?.close() },
  }
}

function pcm16Base64(f32) {
  const bytes = new Uint8Array(new Int16Array(f32.map((v) => Math.max(-1, Math.min(1, v)) * 0x7fff)).buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const join = (a, b) => (a && b && !/\s$/.test(a) && !/^\s/.test(b) ? `${a} ${b}` : a + b)

const PROVIDERS = {
  // https://soniox.com/docs/api-reference/stt/websocket-api
  soniox: {
    label: 'Soniox',
    keyUrl: 'https://console.soniox.com',
    rate: 16000,
    connect(key, on) {
      let final = ''
      const s = socket('wss://stt-rt.soniox.com/transcribe-websocket', undefined, {
        open: (ws) => ws.send(JSON.stringify({
          api_key: key, model: 'stt-rt-v5', audio_format: 'pcm_f32le', sample_rate: 16000, num_channels: 1, language_hints: LANGUAGES,
        })),
        message: (msg) => {
          if (msg.error_code) return on.error(msg.error_message)
          let partial = ''
          for (const t of msg.tokens || []) {
            if (/^<.+>$/.test(t.text)) continue // control tokens like <end>, <fin>
            t.is_final ? (final += t.text) : (partial += t.text)
          }
          msg.finished ? on.done(final) : on.text(final, partial)
        },
        error: on.error,
      })
      return {
        audio: (f32) => s.send(f32.buffer),
        end: () => s.send(''), // empty frame = end of audio; server flushes, then sends finished:true
        close: s.close,
      }
    },
  },

  // https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
  elevenlabs: {
    label: 'ElevenLabs',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    rate: 16000,
    connect(_key, on) {
      let final = '', partial = '', ending = false
      // Browser sockets can't set headers, so main fetches a single-use token with the real key.
      const url = api.elevenToken().then((token) =>
        `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&token=${encodeURIComponent(token)}`)
      const s = socket(url, undefined, {
        message: (msg) => {
          const type = msg.message_type
          if (type.endsWith('error')) return on.error(msg.error || type)
          if (type === 'partial_transcript') partial = msg.text
          else if (type === 'committed_transcript') { final = join(final, msg.text); partial = '' }
          else return
          ending && !partial ? on.done(final) : on.text(final, partial)
        },
        error: on.error,
      })
      const chunk = (f32, commit) => s.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm16Base64(f32), commit, sample_rate: 16000 }))
      return {
        audio: (f32) => chunk(f32, false),
        end: () => {
          ending = true
          chunk(new Float32Array(1600), true) // 100 ms silence + manual commit flushes the last segment
          // VAD may already have committed everything, in which case no further message comes.
          if (!partial) setTimeout(() => on.done(final), 1500)
        },
        close: s.close,
      }
    },
  },

  // https://developers.openai.com/api/docs/guides/realtime-transcription
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    rate: 24000,
    connect(key, on) {
      const items = new Map() // item_id → { text, done }, insertion order = speech order
      let ending = false
      const text = (done) => [...items.values()].filter((i) => i.done === done).map((i) => i.text.trim()).join(' ')
      const s = socket('wss://api.openai.com/v1/realtime?intent=transcription', ['realtime', `openai-insecure-api-key.${key}`], {
        open: (ws) => ws.send(JSON.stringify({
          type: 'session.update',
          session: { type: 'transcription', audio: { input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-live-transcribe' },
            turn_detection: null,
          } } },
        })),
        message: (msg) => {
          if (msg.type === 'error') return on.error(msg.error?.message || 'Fehler')
          if (msg.type === 'conversation.item.input_audio_transcription.delta') {
            const item = items.get(msg.item_id) ?? { text: '', done: false }
            item.text += msg.delta
            items.set(msg.item_id, item)
          } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
            items.set(msg.item_id, { text: msg.transcript, done: true })
          } else return
          ending && [...items.values()].every((i) => i.done) ? on.done(text(true)) : on.text(text(true), text(false))
        },
        error: on.error,
      })
      return {
        audio: (f32) => s.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16Base64(f32) })),
        end: () => { ending = true; s.send(JSON.stringify({ type: 'input_audio_buffer.commit' })) },
        close: s.close,
      }
    },
  },
}
