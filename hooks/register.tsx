import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { LastRequest, SessionInfo, UsageWindow, WarmState } from '../types'

// Die Form-Kennung sorgt dafür, dass Werte einer älteren Version nach dem
// Aktualisieren als leer gelesen werden statt als falsch geformte Daten
const last = atom({ plugin: 'kontext-cache-band', key: 'last' } as const, null, { shape: 'v3' })
const info = atom({ plugin: 'kontext-cache-band', key: 'info' } as const, null, { shape: 'v3' })
const ttlHint = atom({ plugin: 'kontext-cache-band', key: 'ttlHint' } as const, null, { shape: 'v3' })
const warm = atom({ plugin: 'kontext-cache-band', key: 'warm' } as const, null, { shape: 'v1' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// Token kurz und mit Dezimalkomma: 840, 8,4k, 92k, 1M, 1,5M
function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '').replace('.', ',') + 'k'
  if (n < 999_500) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',') + 'M'
}

// Restzeit als m:ss (eine Stunde ist 60:00, damit die Spalte schmal bleibt),
// aufgerundet, damit nie „0:00“ bei noch warmem Cache steht
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Zeit seit Ablauf, in ganzen Minuten oder Stunden, passend zum Neuzeichnen einmal pro Minute
function formatMinutes(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return 'unter 1 min'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

// Ein Balkenabschnitt: zusammenhängende Zellen derselben Art
type Run = { kind: string; text: string }

// Fasst Zellen gleicher Art zu Abschnitten zusammen, damit jeder eine Farbe bekommt
function toRuns(cells: readonly string[], glyph: (kind: string) => string): Run[] {
  const runs: Run[] = []
  for (const kind of cells) {
    const lastRun = runs[runs.length - 1]
    if (lastRun !== undefined && lastRun.kind === kind) lastRun.text += glyph(kind)
    else runs.push({ kind, text: glyph(kind) })
  }
  return runs
}

// Anzahl Zellen für einen Anteil von 0 bis 100; dieselbe Rundung für Füllung und Marke
const cellCount = (percent: number, width: number) =>
  Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

// Zellen aus aufeinanderfolgenden Anteilen, der Rest wird mit 'empty' aufgefüllt
function cellsFrom(width: number, parts: ReadonlyArray<[string, number]>): string[] {
  const cells: string[] = []
  let sum = 0
  for (const [kind, percent] of parts) {
    sum += percent
    const until = cellCount(sum, width)
    while (cells.length < until) cells.push(kind)
  }
  while (cells.length < width) cells.push('empty')
  return cells
}

const glyphs = (kind: string) => (kind === 'empty' ? '░' : kind === 'mark' ? '┃' : '█')

// Prozent rechtsbündig in fester Breite, damit beide Zeilen fluchten; ≈ für Schätzungen
const pct = (n: number, isEstimate = false) => `${isEstimate ? '≈' : ''}${Math.round(n)} %`.padStart(5)

// Spaltenbreiten in Zellen, damit beide Zeilen übereinander fluchten
const LABEL = 9
const PCT = 6

// Farben der Balken. Theme-Schlüssel für Text, feste Werte für die Vektorgrafik,
// die keine Theme-Schlüssel kennt; mittlere Töne, die auf hellem und dunklem Grund lesbar sind
type Tone = 'success' | 'warning' | 'error' | 'subtle'
const TONE: Record<Tone, string> = {
  success: '#4CB05A',
  warning: '#E0A33A',
  error: '#E5534B',
  subtle: '#8A8A8A',
}

// Balken der Desktop-App: abgerundete Spur, Abschnitte darin, optional eine Marke
const BAR_H = 12
function svgBar(
  width: number,
  segments: ReadonlyArray<{ from: number; to: number; color: string }>,
  markAt?: number,
): string {
  const y = 3
  const barH = 6
  const r = barH / 2
  const x = (p: number) => Math.round((Math.max(0, Math.min(100, p)) / 100) * width * 10) / 10
  const parts = segments
    .filter(s => s.to > s.from)
    .map(s => `<rect x="${x(s.from)}" y="${y}" width="${Math.max(0, x(s.to) - x(s.from))}" height="${barH}" fill="${s.color}"/>`)
    .join('')
  const mark =
    markAt === undefined
      ? ''
      : `<rect x="${Math.max(0, Math.min(width - 2, x(markAt) - 1))}" y="0" width="2" height="${BAR_H}" rx="1" fill="${TONE.warning}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_H}" viewBox="0 0 ${width} ${BAR_H}">` +
    `<defs><clipPath id="t"><rect x="0" y="${y}" width="${width}" height="${barH}" rx="${r}"/></clipPath></defs>` +
    `<rect x="0" y="${y}" width="${width}" height="${barH}" rx="${r}" fill="#808080" fill-opacity="0.25"/>` +
    `<g clip-path="url(#t)">${parts}</g>${mark}</svg>`
  )
}

// Kleiner Ring der Desktop-App für ein Nutzungsfenster: Spur, darauf der verbrauchte
// Anteil im Uhrzeigersinn ab 12 Uhr
const RING = 12
function svgRing(percent: number, color: string): string {
  const stroke = 2.5
  const r = (RING - stroke) / 2
  const c = RING / 2
  const length = 2 * Math.PI * r
  const used = Math.round((Math.max(0, Math.min(100, percent)) / 100) * length * 10) / 10
  const arc =
    used <= 0
      ? ''
      : `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" ` +
        `stroke-dasharray="${used} ${length}" transform="rotate(-90 ${c} ${c})"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RING}" height="${RING}" viewBox="0 0 ${RING} ${RING}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#808080" stroke-opacity="0.25" stroke-width="${stroke}"/>` +
    `${arc}</svg>`
  )
}

// Abrechnungsart aus den Nutzungsfenstern: nur das 5-Stunden- und das Wochenfenster
// gibt es ausschließlich im Abo (ein Gateway meldet „spend_limit“, das zählt nicht).
// Ist ein Fenster ausgeschöpft und läuft die Sitzung weiter, geht sie vermutlich über Zusatznutzung.
type Billing = 'abo' | 'zusatz' | 'api' | undefined

function billingFrom(rateLimits: readonly SessionRateLimit[], hasResponse: boolean): Billing {
  const plan = rateLimits.filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
  if (plan.length > 0) return plan.some(r => r.percentUsed >= 100) ? 'zusatz' : 'abo'
  return hasResponse ? 'api' : undefined
}

// Eine Variable aus der Prozessumgebung oder dem env-Block der Einstellungen
function pick(fromProcess: string | undefined, fromSettings: Record<string, string>, name: string) {
  return fromProcess ?? fromSettings[name]
}

const isOn = (value: string | undefined) => value === '1' || value === 'true'

// Cache-Lebensdauer des Hauptgesprächs. Rangfolge nach der Claude-Code-Doku:
// FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, promptCacheTtl, ENABLE_PROMPT_CACHING_1H.
// Ohne eigene Einstellung: ausgeschöpftes Abo-Fenster 5 min, sonst der Wert, den Claude Code
// zuletzt selbst gemeldet hat, sonst Abo 1h und alles andere 5 min.
async function loadConfig($: EngineInterface, billing: Billing) {
  const envBlock = ((await $.settings.read({ key: 'env' })) ?? {}) as Record<string, string>
  const force5m = pick(await $.env.get('FORCE_PROMPT_CACHING_5M'), envBlock, 'FORCE_PROMPT_CACHING_5M')
  const ttlVar = pick(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), envBlock, 'CLAUDE_CODE_PROMPT_CACHE_TTL')
  const enable1h = pick(await $.env.get('ENABLE_PROMPT_CACHING_1H'), envBlock, 'ENABLE_PROMPT_CACHING_1H')
  const disabled = pick(await $.env.get('DISABLE_PROMPT_CACHING'), envBlock, 'DISABLE_PROMPT_CACHING')
  const override = pick(
    await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'),
    envBlock,
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  )
  const setting = await $.settings.read({ key: 'promptCacheTtl' })
  const hint = await read($, ttlHint)

  let ttlMs: number
  let ttlSource: string
  if (isOn(force5m)) {
    ttlMs = 5 * MINUTE
    ttlSource = 'FORCE_PROMPT_CACHING_5M'
  } else if (ttlVar === '5m' || ttlVar === '1h') {
    ttlMs = ttlVar === '1h' ? HOUR : 5 * MINUTE
    ttlSource = 'CLAUDE_CODE_PROMPT_CACHE_TTL'
  } else if (setting === '5m' || setting === '1h') {
    ttlMs = setting === '1h' ? HOUR : 5 * MINUTE
    ttlSource = 'promptCacheTtl'
  } else if (isOn(enable1h)) {
    ttlMs = HOUR
    ttlSource = 'ENABLE_PROMPT_CACHING_1H'
  } else if (billing === 'zusatz') {
    ttlMs = 5 * MINUTE
    ttlSource = 'Zusatznutzung, vermutet'
  } else if (hint !== null) {
    ttlMs = hint.ms
    ttlSource = 'von Claude Code gemeldet'
  } else if (billing === 'abo') {
    ttlMs = HOUR
    ttlSource = 'Abo-Standard'
  } else if (billing === 'api') {
    ttlMs = 5 * MINUTE
    ttlSource = 'Standard ohne Abo'
  } else {
    ttlMs = HOUR
    ttlSource = 'Abo-Standard, angenommen'
  }

  return { ttlMs, ttlSource, isCachingOff: isOn(disabled), autoCompactOverride: override || undefined }
}

// Legt Kontext- und Auto-Compact-Werte in den Zustand. Ohne gemessenen Wert der
// letzten Antwort (Sitzungsbeginn, nach /clear oder Komprimierung) gilt Claude Codes Schätzung.
async function storeInfo($: EngineInterface, usage: SessionUsage) {
  const breakdown = usage.context.breakdown
  const config = await loadConfig($, undefined)
  const measured = usage.context.tokens
  const tokens = measured ?? breakdown?.totalTokens
  const window = usage.context.window
  const next: SessionInfo = {
    tokens,
    window,
    percent: usage.context.percent ?? (tokens !== undefined ? (tokens / window) * 100 : undefined),
    isEstimated: measured === undefined && tokens !== undefined,
    isAutoCompactOn: breakdown?.isAutoCompactEnabled,
    autoCompactAt: breakdown?.autoCompactThreshold,
    autoCompactOverride: config.autoCompactOverride,
    isCachingOff: config.isCachingOff,
    fiveHour: windowFrom(usage.rateLimits, 'five_hour'),
    sevenDay: windowFrom(usage.rateLimits, 'seven_day'),
  }
  await update($, info, () => next)
}

// Ein Nutzungsfenster aus den gemeldeten; ein unlesbarer Zeitpunkt fällt weg
function windowFrom(rateLimits: readonly SessionRateLimit[], kind: string): UsageWindow | undefined {
  const limit = rateLimits.find(r => r.kind === kind)
  if (limit === undefined) return undefined
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  return { percent: limit.percentUsed, resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt }
}

// Die Nutzungsfenster der Fußzeile: Bezeichnung und ab welcher Restzeit die Zurücksetzung dasteht
const WINDOWS = [
  { key: 'fiveHour', label: '5 h', showWithin: HOUR },
  { key: 'sevenDay', label: 'Woche', showWithin: 12 * HOUR },
] as const

// Was die Fußzeile zu einem Fenster zeigt. Ist die gemeldete Zurücksetzung vorbei, gilt
// der alte Stand nicht mehr: 0 %, bis die nächste Anfrage den neuen bringt.
function windowView(window: UsageWindow, label: string, showWithin: number, now: number) {
  const left = window.resetsAt === undefined ? undefined : window.resetsAt - now
  const isReset = left !== undefined && left <= 0
  const percent = isReset ? 0 : window.percent
  const tone: Tone = percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'
  const due = left !== undefined && !isReset && left <= showWithin ? ` (neu in ${formatSpan(left)})` : ''
  const text = `${label} ${pct(percent).trim()}${due}`
  return { percent, tone, text }
}

async function refresh($: EngineInterface) {
  await storeInfo($, await $.session.usage({ breakdown: 'summary' }))
}


// ---- /cache-keep-warm ----------------------------------------------------
//
// Hält den Prompt-Cache des Hauptgesprächs für ein Zeitfenster warm. Kurz vor
// jedem Ablauf schickt $.model.fork die letzte Anfrage des Hauptgesprächs noch
// einmal ab; die API liest sie aus dem Cache, und jeder Treffer setzt dessen
// Lebensdauer ohne Aufpreis neu. Das Gespräch selbst bleibt unverändert.

const WARM_COMMAND = 'cache-keep-warm'
const WARM_DEFAULT = HOUR
const WARM_MAX = 24 * HOUR
const WARM_RETRY = 30_000
const FORK_PROMPT =
  'Automatische Auffrischung des Prompt-Caches durch den Mod kontext-cache-band, keine Aufgabe. Antworte nur mit: ok'

// Wie lange vor dem Ablauf aufgefrischt wird: 5 min bei 1 h, 1 min bei 5 min
const leadTime = (ttlMs: number) => Math.min(5 * MINUTE, ttlMs / 5)

type WarmArgs = { kind: 'stop' } | { kind: 'default' } | { kind: 'window'; ms: number } | { kind: 'invalid' }

// „2h“, „90m“, „90“ (Minuten), „1h30m“, „1h30“, „1,5h“, „1:30“, „stop“
function parseWarmArgs(args: string): WarmArgs {
  const a = args.trim().toLowerCase().replace(',', '.')
  if (a === '') return { kind: 'default' }
  if (['stop', 'aus', 'ende', 'beenden', 'off'].includes(a)) return { kind: 'stop' }
  const toWindow = (ms: number): WarmArgs =>
    Number.isFinite(ms) && ms >= MINUTE && ms <= WARM_MAX ? { kind: 'window', ms: Math.round(ms) } : { kind: 'invalid' }
  const clock = /^(\d+):(\d{1,2})$/.exec(a)
  if (clock) return toWindow(Number(clock[1]) * HOUR + Number(clock[2]) * MINUTE)
  const parts = /^(?:(\d+(?:\.\d+)?)\s*(?:h|std|stunden?))?\s*(?:(\d+)\s*(?:m|min|minuten?)?)?$/.exec(a)
  if (parts === null || (parts[1] === undefined && parts[2] === undefined)) return { kind: 'invalid' }
  return toWindow(Number(parts[1] ?? 0) * HOUR + Number(parts[2] ?? 0) * MINUTE)
}

// Eine Zeitspanne in Stunden und Minuten, aufgerundet auf die Minute
function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE))
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

async function stopWarm($: EngineInterface, reason?: string) {
  await update($, warm, () => null)
  if (reason !== undefined) $.ui.toast(`Cache warm halten beendet: ${reason}`)
  $.ui.invalidate('ui.render')
}

// Läuft gerade eine Auffrischung, startet der Sekundentakt keine zweite
let isPinging = false

async function warmTick($: EngineInterface) {
  const state = await read($, warm)
  if (state === null || isPinging) return
  const now = await $.clock.now()
  if (now >= state.until) {
    await stopWarm($, 'Zeitfenster abgelaufen')
    return
  }
  const request = await read($, last)
  // Noch keine Anfrage (Sitzungsbeginn, nach Modellwechsel): auf die nächste warten
  if (request === null) return
  const expiry = request.at + request.ttlMs
  // Der Cache hält ohnehin bis zum Ende des Fensters
  if (expiry >= state.until) return
  if (now < expiry - leadTime(request.ttlMs)) return
  if (state.nextTryAt !== undefined && now < state.nextTryAt) return

  isPinging = true
  try {
    const result = await $.model.fork({ prompt: FORK_PROMPT })
    if (!result.isAnswered && result.reason === 'nothing-to-fork') {
      await stopWarm($, 'kein Gespräch zum Auffrischen (etwa nach /clear)')
      return
    }
    if (!result.isAnswered && (result.reason === 'api-error' || result.reason === 'aborted')) {
      const error =
        result.reason === 'aborted'
          ? 'Auffrischung abgebrochen'
          : `Auffrischung fehlgeschlagen${result.status === null ? '' : ` (${result.status})`}`
      await update($, warm, v => (v === null ? null : { ...v, error, nextTryAt: now + WARM_RETRY }))
      return
    }
    // Beantwortet oder leere Antwort: die Anfrage lief, ihr Verbrauch zeigt, ob der Cache griff
    const usage = result.usage
    if (usage.cache_read_input_tokens + usage.cache_creation_input_tokens === 0) {
      await stopWarm($, 'die Auffrischung hat nichts gecacht')
      return
    }
    await update($, last, v => (v === null ? null : { ...v, at: now }))
    await update($, warm, v =>
      v === null ? null : { ...v, pings: v.pings + 1, error: undefined, nextTryAt: undefined },
    )
  } finally {
    isPinging = false
  }
}

async function runWarmCommand($: EngineInterface, args: string): Promise<string> {
  const parsed = parseWarmArgs(args)
  const state = await read($, warm)
  const now = await $.clock.now()
  if (parsed.kind === 'invalid') {
    return 'Unbekannte Dauer. Beispiele: /cache-keep-warm 2h, 90m, 1h30m, 1:30 oder stop (höchstens 24 h).'
  }
  if (parsed.kind === 'stop') {
    if (state === null) return 'Cache warm halten läuft nicht.'
    await stopWarm($)
    return `Cache warm halten beendet (${state.pings}× aufgefrischt).`
  }
  if (parsed.kind === 'default' && state !== null) {
    return `Cache warm halten läuft noch ${formatSpan(state.until - now)}, bisher ${state.pings}× aufgefrischt. Beenden: /cache-keep-warm stop`
  }
  const ms = parsed.kind === 'window' ? parsed.ms : WARM_DEFAULT
  await update($, warm, () => ({ startedAt: now, until: now + ms, pings: state?.pings ?? 0 }))
  $.ui.invalidate('ui.render')

  const request = await read($, last)
  let start: string
  if (request === null) {
    start = 'Die erste Auffrischung richtet sich nach der nächsten Antwort.'
  } else if (request.at + request.ttlMs <= now) {
    start =
      'Der Cache ist schon abgelaufen: die erste Auffrischung baut ihn neu auf, das kostet einmal einen Cache-Schreibvorgang.'
  } else {
    const due = request.at + request.ttlMs - leadTime(request.ttlMs)
    start = due <= now ? 'Die erste Auffrischung folgt gleich.' : `Die erste Auffrischung folgt in ${formatSpan(due - now)}.`
  }
  return (
    `Cache wird ${formatSpan(ms)} lang warm gehalten. ${start} ` +
    'Jede Auffrischung liest den ganzen Kontext aus dem Cache und zählt im Abo zur Nutzung. ' +
    'Beenden: /cache-keep-warm stop oder „Beenden“ im Band.'
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await refresh($)
    } catch {
      // Ohne Messung bleibt das Band leer, bis die erste Anfrage fertig ist
    }
    try {
      await $.command.register({
        name: WARM_COMMAND,
        description: 'Hält den Prompt-Cache für ein Zeitfenster warm',
        argumentHint: '[Dauer, z. B. 2h | stop]',
        immediate: true,
      })
    } catch {
      // Ohne Befehl läuft die Anzeige weiter
    }

    // Solange der Cache warm ist, jede Sekunde neu zeichnen (Countdown),
    // danach nur noch einmal pro Minute (Anzeige „kalt seit … min“)
    let drawnMinute = -1
    let drawnClockMinute = -1
    $.clock.every(1000, () => {
      void warmTick($).catch(() => undefined)
      void (async () => {
        try {
          // Die Zeitangaben der Nutzungsfenster in der Fußzeile gehen nach der Uhr
          const current = await read($, info)
          if (current?.fiveHour !== undefined || current?.sevenDay !== undefined) {
            const clockMinute = Math.floor((await $.clock.now()) / MINUTE)
            if (clockMinute !== drawnClockMinute) {
              drawnClockMinute = clockMinute
              $.ui.invalidate('ui.render')
            }
          }
          const request = await read($, last)
          if (request === null) return
          const sinceExpiry = (await $.clock.now()) - (request.at + request.ttlMs)
          if (sinceExpiry <= 0) {
            drawnMinute = -1
            $.ui.invalidate('ui.render')
          } else {
            const minute = Math.floor(sinceExpiry / MINUTE)
            if (minute !== drawnMinute) {
              drawnMinute = minute
              $.ui.invalidate('ui.render')
            }
          }
        } catch {
          // Beim nächsten Takt erneut
        }
      })()
    })

    return started
  })

  // Fortgesetztes Gespräch: Claude Code meldet, wie lange die letzte Antwort her ist
  // und ob der Cache vermutlich abgelaufen ist. Daraus den Cache-Stand schätzen.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const seconds = e.seconds_since_last_response
    if ((e.source === 'resume' || e.source === 'fork') && seconds !== undefined && e.context_tokens) {
      try {
        const age = seconds * 1000
        const isExpired = e.prompt_cache_likely_expired
        // Was Claude Code meldet, verrät die tatsächliche Lebensdauer
        if (isExpired === false && age > 5 * MINUTE) await update($, ttlHint, () => ({ ms: HOUR }))
        else if (isExpired === true && age > 5 * MINUTE && age < HOUR) {
          await update($, ttlHint, () => ({ ms: 5 * MINUTE }))
        }
        const config = await loadConfig($, undefined)
        const request: LastRequest = {
          at: (await $.clock.now()) - age,
          input: 0,
          read: e.context_tokens,
          write: 0,
          // Meldet Claude Code den Cache als abgelaufen, wird er auch so angezeigt
          ttlMs: isExpired === true ? Math.min(config.ttlMs, age) : config.ttlMs,
          ttlSource: config.ttlSource,
          isEstimate: true,
        }
        await update($, last, () => request)
        await refresh($)
      } catch {
        // Dann wartet die Cache-Zeile auf die nächste Anfrage
      }
    }
    return result
  })

  // Modellwechsel: Claude Code meldet die tatsächliche Lebensdauer; der Cache
  // des neuen Modells ist kalt, das Kontextfenster kann sich ändern
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    try {
      await update($, ttlHint, () => ({ ms: e.cache_ttl === '1h' ? HOUR : 5 * MINUTE }))
      await update($, last, () => null)
      await refresh($)
    } catch {
      // Beim nächsten Messen erneut versuchen
    }
    return result
  })

  // Geänderte Einstellungen (Lebensdauer, Auto-Compact) sofort übernehmen
  on('classic.ConfigChange', async ($, e, next) => {
    const result = await next(e)
    try {
      await refresh($)
    } catch {
      // Beim nächsten Messen erneut versuchen
    }
    return result
  })

  // Nach /clear oder dem Wechsel in ein anderes Gespräch gehören die Werte zum alten:
  // sofort leeren, gemessen wird kurz danach außerhalb des knappen Zeitrahmens von session.end
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      try {
        await update($, last, () => null)
        await update($, info, v => (v === null ? null : { ...v, tokens: undefined, percent: undefined }))
        // Das warm gehaltene Gespräch ist nicht mehr das aktuelle
        await update($, warm, () => null)
      } catch {
        // Beim nächsten Messen erneut versuchen
      }
      $.clock.after(1000, () => {
        void refresh($).catch(() => undefined)
      })
    }
    return ended
  })

  // Nach einer Komprimierung des Hauptgesprächs gilt der alte Cache-Stand nicht mehr
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      try {
        await update($, last, () => null)
        await refresh($)
      } catch {
        // Beim nächsten Messen erneut versuchen
      }
    }
    return result
  })

  // Jede Modellanfrage des Hauptgesprächs: Cache-Stand mit der dabei geltenden Lebensdauer
  // merken und den Kontext neu messen, damit beide Zeilen auch mitten in einer Runde stimmen.
  // Subagenten haben einen eigenen Cache und eigenen Kontext und zählen nicht.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const at = await $.clock.now()
    const result = yield* next(e)
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      if (result.usage !== null) {
        const config = await loadConfig($, billingFrom(usage.rateLimits, true))
        const request: LastRequest = {
          at,
          input: result.usage.input_tokens,
          read: result.usage.cache_read_input_tokens,
          write: result.usage.cache_creation_input_tokens,
          ttlMs: config.ttlMs,
          ttlSource: config.ttlSource,
        }
        await update($, last, () => request)
      }
      await storeInfo($, usage)
    } catch {
      // Die Anfrage selbst bleibt unberührt
    }
    return result
  })

  // Nach jeder Runde und wenn sich ein Nutzungsfenster bewegt: neu messen
  on('session.measure', async ($, e, next) => {
    try {
      await refresh($)
    } catch {
      // Beim nächsten Messen erneut versuchen
    }
    return next(e)
  })

  on('command.run', { command: WARM_COMMAND }, async ($, e) => ({ text: await runWarmCommand($, e.args) }))

  // Fußzeile unter dem Eingabefeld, rechts bei den Modus-Angaben: 5-Stunden- und
  // Wochenlimit. Im Terminal als weitere Modus-Angaben, in der Desktop-App mit kleinem Ring.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const current = await read($, info)
    if (current === null) return next(e)
    const now = await $.clock.now()
    const views = WINDOWS.flatMap(w => {
      const window = current[w.key]
      return window === undefined ? [] : [windowView(window, w.label, w.showWithin, now)]
    })
    if (views.length === 0) return next(e)
    if (e.surface !== 'desktop') {
      return next({ ...e, props: { ...e.props, modes: [...e.props.modes, ...views.map(v => v.text)] } })
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {e.props.modes.length === 0 ? null : <Text dimColor>{`${e.props.modes.join(' & ')} ·`}</Text>}
        {views.map(v => (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Svg source={svgRing(v.percent, TONE[v.tone])} alt={`Nutzungslimit ${v.text}`} width={RING} height={RING} />
            <Text dimColor>{v.text}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const current = await read($, info)
    if (current === null) return next(e)
    const request = await read($, last)
    const now = await $.clock.now()

    const isNarrow = e.props.bodyColumns < 90

    // Zeile 1: Kontext, die Auto-Compact-Schwelle als Marke im Balken
    const percent = current.percent
    const isEstimated = current.isEstimated === true
    const autoPercent =
      current.isAutoCompactOn === true && current.autoCompactAt !== undefined
        ? (current.autoCompactAt / current.window) * 100
        : undefined
    const contextColor: Tone =
      percent === undefined
        ? 'subtle'
        : percent >= 90
          ? 'error'
          : autoPercent !== undefined && percent >= autoPercent - 5
            ? 'warning'
            : 'success'

    let contextLeft: string
    if (percent === undefined || current.tokens === undefined) {
      contextLeft = 'noch keine Messung'
    } else {
      contextLeft = `${isEstimated ? '≈' : ''}${formatTokens(current.tokens)} von ${formatTokens(current.window)}`
      if (isEstimated) contextLeft += ' (geschätzt)'
    }
    let contextRight: string
    if (current.isAutoCompactOn === undefined) {
      contextRight = 'Auto-Compact unbekannt'
    } else if (autoPercent === undefined || current.autoCompactAt === undefined) {
      contextRight = 'Auto-Compact aus'
    } else {
      contextRight = `Auto-Compact bei ${formatTokens(current.autoCompactAt)} (${Math.round(autoPercent)} %)`
      if (current.tokens !== undefined && current.tokens < current.autoCompactAt) {
        contextRight += `, noch ${formatTokens(current.autoCompactAt - current.tokens)}`
      }
    }
    if (current.autoCompactOverride !== undefined) {
      contextRight += ` · Override ${current.autoCompactOverride} %`
    }

    // Zeile 2: Cache. Der Balken ist die Restzeit bis zum Ablauf (voll direkt nach einer
    // Anfrage, leer wenn kalt); die Trefferquote steht abgerundet im Text
    type CacheView =
      | { kind: 'message'; text: string }
      | {
          kind: 'bar'
          left: number
          isWarm: boolean
          remaining: number
          isEstimate: boolean
          hit: string
          tokens: string
          ttl: string
          ttlLabel: string
        }
    let cache: CacheView
    if (current.isCachingOff) {
      cache = { kind: 'message', text: 'abgeschaltet' }
    } else if (request === null) {
      cache = { kind: 'message', text: 'wartet auf die nächste Anfrage' }
    } else if (request.read + request.write === 0) {
      // Nichts gecacht: Prompt unter der Mindestgröße oder Caching fürs Modell abgeschaltet
      cache = { kind: 'message', text: 'letzte Anfrage nicht gecacht' }
    } else {
      const cached = request.read + request.write
      const total = cached + request.input
      const remaining = request.at + request.ttlMs - now
      const isEstimate = request.isEstimate === true
      const isWarm = remaining > 0
      const ttlLabel = request.ttlMs >= HOUR ? '1h' : '5 min'
      // Treffer sind nur die aus dem Cache gelesenen Token. Neu geschriebene sind ein
      // Fehlschlag, sonst stünde nach kaltem Cache (alles neu geschrieben) „100 % Treffer“.
      // Abgerundet: 99,7 % sind noch nicht 100 %. Bei einer Schätzung (fortgesetztes
      // Gespräch) ist die Quote unbekannt; nach Ablauf gilt sie nur für die letzte Anfrage.
      const hitPct = Math.floor((request.read / total) * 100)
      cache = {
        kind: 'bar',
        left: Math.max(0, Math.min(100, (remaining / request.ttlMs) * 100)),
        isWarm,
        remaining,
        isEstimate,
        hit: isEstimate ? '' : `${isWarm ? '' : 'zuletzt '}${hitPct} % Treffer · `,
        tokens: isEstimate
          ? `≈${formatTokens(cached)} aus dem fortgesetzten Gespräch`
          : `${formatTokens(cached)} (${formatTokens(request.read)} gelesen, ${formatTokens(request.write)} neu)`,
        ttl: `TTL ${ttlLabel}, ${request.ttlSource}`,
        ttlLabel,
      }
    }
    // Farbe der Restzeit: grün, in der letzten Minute gelb, abgelaufen grau
    const cacheTone: Tone =
      cache.kind !== 'bar' || !cache.isWarm ? 'subtle' : cache.remaining < MINUTE ? 'warning' : 'success'
    const countdown =
      cache.kind !== 'bar' ? '' : cache.isWarm ? `${cache.isEstimate ? '≈' : ''}${formatDuration(cache.remaining)}` : 'kalt'
    const contextPctText = percent === undefined ? '' : pct(percent, isEstimated).trim()

    // Zeile 3, nur während /cache-keep-warm läuft
    const warmState = await read($, warm)
    let warmText = ''
    if (warmState !== null) {
      warmText = `aktiv, noch ${formatSpan(warmState.until - now)} · ${warmState.pings}× aufgefrischt`
      if (request !== null) {
        const expiry = request.at + request.ttlMs
        const due = expiry - leadTime(request.ttlMs)
        if (expiry >= warmState.until) warmText += ' · Cache hält bis Fensterende'
        else if (warmState.nextTryAt === undefined) {
          warmText += due <= now ? ' · Auffrischung läuft' : ` · nächste in ${formatSpan(due - now)}`
        }
      } else {
        warmText += ' · wartet auf die nächste Antwort'
      }
    }

    // Was andere Mods und Claude Code selbst hier zeichnen (etwa „You should know“),
    // bleibt erhalten und steht unter den zwei Zeilen
    const below = await next(e)

    // Desktop-App: Proportionalschrift, Balken als Vektorgrafik, Einzelheiten
    // links und rechtsbündig
    if (e.surface === 'desktop') {
      const { Box, Text, Svg, Button } = $.ui.resolve(e)
      const barWidth = isNarrow ? 110 : 180

      const contextSvg = svgBar(
        barWidth,
        percent === undefined ? [] : [{ from: 0, to: percent, color: TONE[contextColor] }],
        autoPercent,
      )
      const cacheSvg = svgBar(
        barWidth,
        cache.kind === 'bar' && cache.isWarm ? [{ from: 0, to: cache.left, color: TONE[cacheTone] }] : [],
      )

      const contextAlt =
        percent === undefined
          ? 'Kontext: noch keine Messung'
          : `Kontext ${contextPctText} belegt` +
            (autoPercent === undefined ? '' : `, Auto-Compact bei ${Math.round(autoPercent)} %`)
      const cacheAlt =
        cache.kind !== 'bar'
          ? `Cache: ${cache.text}`
          : cache.isWarm
            ? `Cache: noch ${formatDuration(cache.remaining)} von ${cache.ttlLabel}`
            : `Cache: abgelaufen seit ${formatMinutes(-cache.remaining)}`

      const row = (
        label: string,
        svg: string,
        alt: string,
        pctCell: JSX.Element,
        left: JSX.Element,
        right: JSX.Element | null,
      ) => (
        <Box flexDirection="row" alignItems="center">
          <Box width={LABEL}>
            <Text weight="medium">{label}</Text>
          </Box>
          <Svg source={svg} alt={alt} width={barWidth} height={BAR_H} />
          <Box width={PCT} justifyContent="flex-end" marginRight={2}>
            {pctCell}
          </Box>
          <Box flexGrow={1} flexShrink={1} flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
            {left}
            {right}
          </Box>
        </Box>
      )

      const cachePctCell =
        cache.kind !== 'bar' ? (
          <Text>{''}</Text>
        ) : (
          <Text tabular color={cache.isWarm ? cacheTone : 'error'}>
            {countdown}
          </Text>
        )
      const cacheLeft =
        cache.kind === 'message' ? (
          <Text dimColor>{cache.text}</Text>
        ) : (
          <Text>
            {cache.isWarm ? '' : `seit ${formatMinutes(-cache.remaining)} · `}
            {cache.hit}{cache.tokens}
          </Text>
        )
      const cacheRight = cache.kind === 'bar' ? <Text dimColor>{cache.ttl}</Text> : null

      return (
        <Box flexDirection="column" rowGap={0}>
          {row(
            'Kontext',
            contextSvg,
            contextAlt,
            <Text tabular>{contextPctText}</Text>,
            <Text tabular>{contextLeft}</Text>,
            <Text dimColor>{contextRight}</Text>,
          )}
          {row('Cache', cacheSvg, cacheAlt, cachePctCell, cacheLeft, cacheRight)}
          {warmState === null ? null : (
            <Box flexDirection="row" alignItems="center">
              {/* Ohne Bezeichnung, unter den Balken eingerückt */}
              <Box width={LABEL} />
              <Box flexGrow={1} flexShrink={1} flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
                <Text>
                  <Text color="success">{warmText}</Text>
                  {warmState.error === undefined ? '' : <Text color="warning"> · {warmState.error}, neuer Versuch gleich</Text>}
                </Text>
                <Button key="keep-warm-stop" label="Beenden" hotkey="b" onPress={() => void stopWarm($)} />
              </Box>
            </Box>
          )}
          {below}
        </Box>
      )
    }

    // Terminal: feste Zellen, Balken aus Blockzeichen
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = isNarrow ? 10 : 20

    const contextCells = cellsFrom(width, [['fill', percent ?? 0]])
    if (autoPercent !== undefined) {
      // Die Zelle, mit der die Füllung die Schwelle erreicht
      contextCells[Math.max(0, cellCount(autoPercent, width) - 1)] = 'mark'
    }
    const contextBar = toRuns(contextCells, glyphs).map(run =>
      run.kind === 'fill' ? (
        <Text color={contextColor}>{run.text}</Text>
      ) : run.kind === 'mark' ? (
        <Text color="warning">{run.text}</Text>
      ) : (
        <Text dimColor>{run.text}</Text>
      ),
    )

    let cacheBar = <Text dimColor>{'░'.repeat(width)}</Text>
    let cachePctCell = <Text>{''}</Text>
    let cacheLeft = <Text dimColor>{cache.kind === 'message' ? cache.text : ''}</Text>
    let cacheRight: JSX.Element | null = null
    if (cache.kind === 'bar') {
      if (cache.isWarm) {
        cacheBar = (
          <Text>
            {toRuns(cellsFrom(width, [['fill', cache.left]]), glyphs).map(run =>
              run.kind === 'empty' ? <Text dimColor>{run.text}</Text> : <Text color={cacheTone}>{run.text}</Text>,
            )}
          </Text>
        )
      }
      cachePctCell = <Text color={cache.isWarm ? cacheTone : 'error'}>{countdown}</Text>
      cacheLeft = (
        <Text>
          {cache.isWarm ? '' : `seit ${formatMinutes(-cache.remaining)} · `}
          {cache.hit}{cache.tokens}
        </Text>
      )
      cacheRight = <Text dimColor>{cache.ttl}</Text>
    }

    const termRow = (label: string, bar: JSX.Element, pctCell: JSX.Element, left: JSX.Element, right: JSX.Element | null) => (
      <Box flexDirection="row">
        <Box width={LABEL}>
          <Text>{label}</Text>
        </Box>
        <Box width={width + 1}>{bar}</Box>
        <Box width={PCT} justifyContent="flex-end" marginRight={2}>
          {pctCell}
        </Box>
        <Box flexGrow={1} flexShrink={1} flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          {left}
          {right}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {termRow(
          'Kontext',
          <Text>{contextBar}</Text>,
          <Text>{contextPctText}</Text>,
          <Text>{contextLeft}</Text>,
          <Text dimColor>{contextRight}</Text>,
        )}
        {termRow('Cache', cacheBar, cachePctCell, cacheLeft, cacheRight)}
        {warmState === null ? null : (
          <Box flexDirection="row">
            {/* Ohne Bezeichnung, unter den Balken eingerückt */}
            <Box width={LABEL} />
            <Box flexGrow={1} flexShrink={1} flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
              <Text>
                <Text color="success">{warmText}</Text>
                {warmState.error === undefined ? '' : <Text color="warning"> · {warmState.error}, neuer Versuch gleich</Text>}
              </Text>
              <Button key="keep-warm-stop" label="Beenden" hotkey="b" onPress={() => void stopWarm($)} />
            </Box>
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
