import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'kontext-cache-band',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 0,
  context: {
    tokens: 90_000,
    window: 200_000,
    percent: 45,
    breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 167_000 },
  },
  rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
}

const STEP_RESULT = {
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn',
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_read_input_tokens: 85_000,
    cache_creation_input_tokens: 4_000,
    model: 'm',
  },
}

// Antwort auf $.model.fork; ein Test setzt sie um, um Fehler zu spielen
const FORK_OK = {
  isAnswered: true,
  text: 'ok',
  usage: {
    input_tokens: 40,
    output_tokens: 2,
    cache_read_input_tokens: 89_000,
    cache_creation_input_tokens: 0,
    model: 'm',
  },
}
let forkAnswer: unknown = FORK_OK
let forks = 0
// Verbrauch der Hauptanfragen; ein Test setzt ihn um, etwa für einen kalten Cache
let stepUsage: unknown = STEP_RESULT.usage
const toasts: string[] = []

// Was unter dem Mod steht: Claude Code und andere Mods, hier eine Zeile „unten“
function engine(on: On, usage: unknown = USAGE) {
  forkAnswer = FORK_OK
  forks = 0
  stepUsage = STEP_RESULT.usage
  toasts.length = 0
  on('model.fork', () => {
    forks += 1
    return { value: forkAnswer as never }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined } as never
  })
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: (typeof usage === 'function' ? usage() : usage) as never }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.ConfigChange', () => ({}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('turn.step', async function* (_, e) {
    return { ...STEP_RESULT, usage: stepUsage, turnId: e.turnId, index: e.index } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>unten</Text>
  })
}

test('Band zeigt Kontext, Auto-Compact und warmen Cache auf jeder Fläche', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
  await clock.advance(90_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // Einzelheiten: Token links, Auto-Compact rechtsbündig
    expect((await ui.find({ type: 'Text', text: /von 200k/ }))?.text).toBe('90k von 200k')
    expect((await ui.find({ type: 'Text', text: /^Auto-Compact/ }))?.text).toBe('Auto-Compact: 84 %')
    expect((await ui.find({ type: 'Text', text: /^45 %$/ }))?.text).toBe('45 %')
    // Cache: Restzeit in der Spalte neben dem Balken, Trefferquote nur aus gelesenen Token, abgerundet (85k von 90k sind 94,4 %, also 94 %)
    expect((await ui.find({ type: 'Text', text: /^58:30$/ }))?.text).toBe('58:30')
    expect((await ui.find({ type: 'Text', text: /gelesen/ }))?.text).toBe('94 % Treffer · 89k (85k gelesen, 4k neu)')
    expect((await ui.find({ type: 'Text', text: /^TTL/ }))?.text).toBe('TTL 1h, Abo-Standard')
    // Je Zeile ein Einzelheiten-Block mit links und rechts verteilten Teilen
    const spread = (await ui.findAll({ type: 'Box' })).filter(b => b.props.justifyContent === 'space-between')
    expect(spread.length).toBe(2)
    if (surface === 'terminal') {
      // Kontext-Balken: 9 von 20 Zellen gefüllt, Marke bei 84 %
      expect((await ui.find({ type: 'Text', text: /┃/ }))?.text).toBe('█████████░░░░░░░┃░░░')
      // Restzeit 58:30 von 60:00 sind 97,5 %, gerundet alle 20 Zellen
      expect((await ui.find({ type: 'Text', text: /^█{20}$/ }))?.text).toBe('█'.repeat(20))
    } else {
      // Desktop: keine Blockzeichen, Balken als Grafik
      expect(await ui.find({ type: 'Text', text: /[█░┃]/ })).toBeUndefined()
      // Zwei Balken; die Ringe der Nutzungsfenster zählen nicht dazu
      const bars = (await ui.findAll({ type: 'Svg' })).filter(b => !String(b.props.alt).startsWith('Nutzungslimits'))
      expect(bars.length).toBe(2)
      expect(bars[0]?.props.alt).toBe('Kontext 45 % belegt, Auto-Compact bei 84 %')
      expect(bars[0]?.props.width).toBe(180)
      const contextSource = String(bars[0]?.props.source)
      expect(contextSource).toContain('width="81" height="6" fill="#4CB05A"')
      expect(contextSource).toContain('x="149.3" y="0" width="2"')
      expect(bars[1]?.props.alt).toBe('Cache: noch 58:30 von 1h')
      expect(String(bars[1]?.props.source)).toContain('width="175.5" height="6" fill="#4CB05A"')
    }
    // Was darunter gezeichnet wird, bleibt sichtbar
    expect((await ui.find({ type: 'Text', text: /^unten$/ }))?.text).toBe('unten')
    await ui.unmount()
  }
})

test('Schmale Fläche: kürzere Balken', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const narrow = { ...BAND, props: { ...BAND.props, bodyColumns: 80 } }

  const desktop = await $.ui.mount({ ...narrow, surface: 'desktop' })
  expect((await desktop.findAll({ type: 'Svg' }))[0]?.props.width).toBe(110)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...narrow, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /┃/ }))?.text).toBe('█████░░┃░░')
  await terminal.unmount()
})

test('Kalter Cache mit 5-Minuten-TTL aus der Umgebung', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' })
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
  await clock.advance(7 * 60_000 + 5_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^kalt$/ }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: /gelesen/ }))?.text).toBe('seit 2 min · zuletzt 94 % Treffer · 89k (85k gelesen, 4k neu)')
  // Kalter Cache: leerer Balken, nur die Spur
  const bar = String((await ui.findAll({ type: 'Svg' }))[1]?.props.source)
  expect(bar).not.toContain('fill="#4CB05A"')
  expect(bar).not.toContain('fill="#8A8A8A"')
  expect((await ui.find({ type: 'Text', text: /^TTL/ }))?.text).toContain('TTL 5 min')
  // Auch mit gesetztem Override nur die Prozentzahl
  expect((await ui.find({ type: 'Text', text: /^Auto-Compact/ }))?.text).toBe('Auto-Compact: 84 %')
  await ui.unmount()
})

test('Nach /clear wartet der Cache auf die nächste Anfrage', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
  await $.session.end({ reason: 'clear' } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /nächste Anfrage/ }))?.text).toBe('wartet auf die nächste Anfrage')
  await ui.unmount()
})

test('Fehlt die Aufschlüsselung, steht Auto-Compact auf unbekannt statt aus', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on, { ...USAGE, context: { tokens: 90_000, window: 200_000, percent: 45 } })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /von 200k/ }))?.text).toBe('90k von 200k')
  expect((await ui.find({ type: 'Text', text: /^Auto-Compact/ }))?.text).toBe('Auto-Compact: unbekannt')
  await ui.unmount()
})

test('Ohne Abo-Fenster gilt die 5-Minuten-Lebensdauer schon in der ersten Runde', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  // Ein Gateway meldet nur ein spend_limit: das ist kein Abo
  engine(on, { ...USAGE, rateLimits: [{ kind: 'spend_limit', percentUsed: 40 }] })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
  await clock.advance(60_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^4:00$/ }))?.text).toBe('4:00')
  expect((await ui.find({ type: 'Text', text: /^TTL/ }))?.text).toBe('TTL 5 min, Standard ohne Abo')
  await ui.unmount()
})

test('Ausgeschöpftes Abo-Fenster: vermutlich Zusatznutzung mit 5 Minuten', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }] })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^TTL/ }))?.text).toBe('TTL 5 min, Zusatznutzung, vermutet')
  await ui.unmount()
})

test('Kontext ohne gemessene Antwort zeigt Claude Codes Schätzung', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on, {
    ...USAGE,
    rateLimits: [],
    context: { window: 200_000, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 167_000, totalTokens: 12_000 } },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /von 200k/ }))?.text).toBe('≈12k von 200k (geschätzt)')
  expect((await ui.find({ type: 'Text', text: /^Auto-Compact/ }))?.text).toBe('Auto-Compact: 84 %')
  expect((await ui.find({ type: 'Text', text: /≈6 %/ }))?.text).toBe('≈6 %')
  await ui.unmount()
})

test('Kontext-Zeile folgt jeder Anfrage, nicht erst dem Rundenende', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  let tokens = 90_000
  engine(on, () => ({
    ...USAGE,
    context: { ...USAGE.context, tokens, percent: Math.round((tokens / 200_000) * 100) },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  tokens = 120_000
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3 } as never)) {
    // nur durchlaufen
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /von 200k/ }))?.text).toContain('120k von 200k')
  await ui.unmount()
})

test('Fortgesetztes Gespräch: Cache-Stand aus Claude Codes Angaben geschätzt', async ($, on) => {
  mock.clock(on, { now: 10_000_000 })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: [] })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // 20 Minuten her und laut Claude Code noch warm: also 1 Stunde Lebensdauer
  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 1200,
    context_tokens: 70_000,
    prompt_cache_likely_expired: false,
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /fortgesetzten/ }))?.text).toBe('≈70k aus dem fortgesetzten Gespräch')
  expect((await ui.find({ type: 'Text', text: /^≈40:00$/ }))?.text).toBe('≈40:00')
  expect((await ui.find({ type: 'Text', text: /^TTL/ }))?.text).toBe('TTL 1h, von Claude Code gemeldet')
  await ui.unmount()
})

test('Modellwechsel: Lebensdauer von Claude Code, Cache des neuen Modells kalt', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
  await $.classic.PostModelSwitch({
    from_model: 'a',
    to_model: 'b',
    requested_model: 'b',
    source: 'command',
    context_tokens: 90_000,
    prompt_cache_warm: true,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0.1,
    pricing: 'catalog',
  })

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /nächste Anfrage/ }))?.text).toBe('wartet auf die nächste Anfrage')
  await ui.unmount()

  // Die nächste Anfrage nimmt die gemeldete Lebensdauer, obwohl ein Abo erkannt wird
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'b', messageCount: 3 } as never)) {
    // nur durchlaufen
  }
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^5:00$/ }))?.text).toBe('5:00')
  expect((await ui.find({ type: 'Text', text: /^TTL/ }))?.text).toBe('TTL 5 min, von Claude Code gemeldet')
  await ui.unmount()
})

test('Letzte Minute: Restzeit und Balken gelb', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
  await clock.advance(4 * 60_000 + 30_000)

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /^0:30$/ }))?.props.color).toBe('warning')
  expect(String((await desktop.findAll({ type: 'Svg' }))[1]?.props.source)).toContain('width="18" height="6" fill="#E0A33A"')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /^██$/ }))?.props.color).toBe('warning')
  await terminal.unmount()
})

async function firstRequest($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
}

const runWarm = ($: Engine, args: string) =>
  $.command.run({ command: 'cache-keep-warm', args } as never)

// Spult zwei Stunden im Sekundentakt vor: braucht mehr als die üblichen 5 s
test('Warm halten: frischt kurz vor Ablauf auf und endet mit dem Zeitfenster', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)
  await firstRequest($)

  const started = await runWarm($, '2h')
  expect(started.text).toContain('Cache wird 2 h lang warm gehalten. Die erste Auffrischung folgt in 55 min.')

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^aktiv/ }))?.text).toBe('aktiv, noch 2 h · 0× aufgefrischt · nächste in 55 min')
  expect(await ui.find({ type: 'Button', key: 'keep-warm-stop' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Warm$/ })).toBeUndefined()
  await ui.unmount()

  // Bei 55 min die erste Auffrischung, die Restzeit beginnt von vorn
  await clock.advance(55 * 60_000 + 2_000)
  expect(forks).toBe(1)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^aktiv/ }))?.text).toContain('1× aufgefrischt · nächste in 55 min')
  expect((await ui.find({ type: 'Text', text: /^5\d:\d\d$|^60:00$/ }))?.text).toMatch(/^(59:5\d|60:00)$/)
  await ui.unmount()

  // Bei 1 h 50 die zweite; danach hält der Cache bis Fensterende, keine dritte
  await clock.advance(55 * 60_000)
  expect(forks).toBe(2)
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /^aktiv/ }))?.text).toContain('2× aufgefrischt · Cache hält bis Fensterende')
  await terminal.unmount()

  await clock.advance(11 * 60_000)
  expect(forks).toBe(2)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^aktiv/ })).toBeUndefined()
  await ui.unmount()
})

test('Warm halten: Beenden im Band und per Befehl', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)
  await firstRequest($)

  await runWarm($, '90m')
  for (const surface of ['terminal', 'desktop'] as const) {
    await runWarm($, '90m')
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^aktiv/ }))?.text).toContain('noch 1 h 30 min')
    await ui.press({ key: 'keep-warm-stop' })
    expect(await ui.find({ type: 'Text', text: /^aktiv/ })).toBeUndefined()
    await ui.unmount()
  }

  expect((await runWarm($, 'stop')).text).toBe('Cache warm halten läuft nicht.')
  await runWarm($, '1:30')
  expect((await runWarm($, '')).text).toContain('läuft noch 1 h 30 min')
  expect((await runWarm($, 'aus')).text).toBe('Cache warm halten beendet (0× aufgefrischt).')
})

test('Warm halten: Dauer-Angaben', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)
  await firstRequest($)

  const cases: Array<[string, string]> = [
    ['45', '45 min'],
    ['1h30m', '1 h 30 min'],
    ['1h30', '1 h 30 min'],
    ['1,5h', '1 h 30 min'],
    ['2 std', '2 h'],
    ['', '1 h'],
  ]
  for (const [args, span] of cases) {
    await runWarm($, 'stop')
    expect((await runWarm($, args)).text).toContain(`Cache wird ${span} lang warm gehalten`)
  }
  for (const bad of ['3x', '25h', '0', 'h']) {
    expect((await runWarm($, bad)).text).toContain('Unbekannte Dauer')
  }
})

test('Warm halten: Fehler zeigt Hinweis und versucht nach 30 s erneut', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  engine(on)
  await firstRequest($)

  await runWarm($, '1h')
  forkAnswer = {
    isAnswered: false,
    reason: 'api-error',
    status: 529,
    error: 'overloaded_error',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
  }
  // 5-min-TTL: Auffrischung 1 min vor Ablauf
  await clock.advance(4 * 60_000 + 2_000)
  expect(forks).toBe(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /fehlgeschlagen/ }))?.text).toContain('0× aufgefrischt · Auffrischung fehlgeschlagen (529), neuer Versuch gleich')
  await ui.unmount()

  forkAnswer = FORK_OK
  await clock.advance(15_000)
  expect(forks).toBe(1)
  await clock.advance(16_000)
  expect(forks).toBe(2)
})

test('Warm halten: ohne Gespräch zum Auffrischen endet es', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)
  await firstRequest($)

  await runWarm($, '3h')
  forkAnswer = { isAnswered: false, reason: 'nothing-to-fork' }
  await clock.advance(55 * 60_000 + 2_000)
  expect(forks).toBe(1)
  expect((await runWarm($, 'stop')).text).toBe('Cache warm halten läuft nicht.')
})

test('Warm halten: /clear beendet es', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)
  await firstRequest($)

  await runWarm($, '2h')
  await $.session.end({ reason: 'clear' } as never)
  expect((await runWarm($, 'stop')).text).toBe('Cache warm halten läuft nicht.')
})

test('Anfrage auf kalten Cache: neu geschriebene Token zählen nicht als Treffer', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
  engine(on)
  stepUsage = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 89_000, model: 'm' }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /gelesen/ }))?.text).toBe('0 % Treffer · 89k (0 gelesen, 89k neu)')
    await ui.unmount()
  }
})

// ---- Nutzungsfenster als Ringe im Band ---------------------------------------

const NOW = Date.parse('2026-10-29T10:00:00Z') // 29.10.2026, 11:00 in Wien
const MIN = 60_000
const H = 60 * MIN
const at = (ms: number) => new Date(NOW + ms).toISOString()
const windows = (five?: [number, number], week?: [number, number]) => [
  ...(five === undefined ? [] : [{ kind: 'five_hour', percentUsed: five[0], resetsAt: at(five[1]) }]),
  ...(week === undefined ? [] : [{ kind: 'seven_day', percentUsed: week[0], resetsAt: at(week[1]) }]),
]

// Der Ring der Nutzungsfenster in der Desktop-App: die Grafik mit Tooltip
async function rings($: Engine) {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = (await ui.findAll({ type: 'Svg' })).find(s => String(s.props.alt).startsWith('Nutzungslimits'))
  await ui.unmount()
  return svg
}
const titleOf = (svg: { props: Record<string, unknown> } | undefined) =>
  /<title>([^<]*)<\/title>/.exec(String(svg?.props.source))?.[1]

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // nur durchlaufen
  }
}

test('Ringe: rechts neben beiden Zeilen, ohne Zahlen, Werte im Tooltip', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([92, 3 * H], [75, 4 * 24 * H]) })
  await start($)
  const svg = await rings($)
  expect(svg?.props.width).toBe(36)
  expect(svg?.props.height).toBe(36)
  // Interaktiv gezeichnet, sonst gibt es keinen Tooltip
  expect(svg?.props.isInteractive).toBe(true)
  expect(titleOf(svg)).toBe('5-Stunden-Limit: 92 %\nWochenlimit: 75 %')
  const source = String(svg?.props.source)
  // Außen (r 16) die Woche gelb ab 70 %, innen (r 10) 5 h rot ab 90 %
  expect(source).toMatch(/r="16" fill="none" stroke="#E0A33A"/)
  expect(source).toMatch(/r="10" fill="none" stroke="#E5534B"/)
  // Keine Zahlen neben den Ringen
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Limit|Woche|92|75/ })).toBeUndefined()
  await ui.unmount()
})

test('Ringe: Zeit im Tooltip bei 5 h erst in der letzten Stunde', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([23, 61 * MIN], [41, 4 * 24 * H]) })
  await start($)
  expect(titleOf(await rings($))).toBe('5-Stunden-Limit: 23 %\nWochenlimit: 41 %')
  await clock.advance(MIN)
  expect(titleOf(await rings($))).toBe('5-Stunden-Limit: 23 %, neu in 1 h\nWochenlimit: 41 %')
  await clock.advance(MIN)
  expect(titleOf(await rings($))).toBe('5-Stunden-Limit: 23 %, neu in 59 min\nWochenlimit: 41 %')
})

test('Ringe: Zeit im Tooltip bei der Woche erst in den letzten 12 Stunden', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([23, 3 * H], [41, 12 * H + MIN]) })
  await start($)
  expect(titleOf(await rings($))).toBe('5-Stunden-Limit: 23 %\nWochenlimit: 41 %')
  await clock.advance(31 * MIN)
  expect(titleOf(await rings($))).toBe('5-Stunden-Limit: 23 %\nWochenlimit: 41 %, neu in 11 h 30 min')
})

test('Ringe: nach der Zurücksetzung 0 % ohne Zusatz', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([88, 30 * MIN], [41, 4 * 24 * H]) })
  await start($)
  await clock.advance(31 * MIN)
  const svg = await rings($)
  expect(titleOf(svg)).toBe('5-Stunden-Limit: 0 %\nWochenlimit: 41 %')
  // Innerer Ring nur noch Spur, kein Bogen
  expect(String(svg?.props.source)).not.toMatch(/r="10"[^>]*stroke-dasharray/)
})

test('Ringe: ein fehlendes Fenster steht im Tooltip als nicht gemeldet', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([23, 3 * H]) })
  await start($)
  const svg = await rings($)
  expect(titleOf(svg)).toBe('5-Stunden-Limit: 23 %\nWochenlimit: nicht gemeldet')
  expect(String(svg?.props.source)).not.toMatch(/r="16"[^>]*stroke-dasharray/)
})

test('Ringe: ohne Abo-Fenster keine Ringe', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: [] })
  await start($)
  expect(await rings($)).toBeUndefined()
})

test('Ringe: das Terminal zeigt keine Nutzungsfenster', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([23, 3 * H], [41, 4 * 24 * H]) })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Limit|Woche|23 %|41 %/ })).toBeUndefined()
  await ui.unmount()
})

test('Prüfbefehl zeigt gemeldete und fehlende Fenster unverändert', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: windows([23, 3 * H]) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = (await $.command.run({ command: 'kontext-cache-band-limits', args: '' } as never)) as { text: string }
  expect(result.text).toBe(
    [
      'Abfragezeitpunkt (UTC): 2026-10-29T10:00:00.000Z',
      '',
      'Von Claude Code gemeldet (rateLimits, Anzahl 1):',
      '  {"kind":"five_hour","percentUsed":23,"resetsAt":"2026-10-29T13:00:00.000Z"}',
      '  seven_day: nicht gemeldet',
      '',
      'Vom Mod zuletzt gespeichert (Grundlage der Fußzeile):',
      '  fiveHour: 23 %, Zurücksetzung 2026-10-29T13:00:00.000Z',
      '  sevenDay: nichts',
    ].join('\n'),
  )
})

test('Prüfbefehl ohne Abo-Fenster', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  engine(on, { ...USAGE, rateLimits: [] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = (await $.command.run({ command: 'kontext-cache-band-limits', args: '' } as never)) as { text: string }
  expect(result.text).toContain('rateLimits, Anzahl 0')
  expect(result.text).toContain('  five_hour: nicht gemeldet\n  seven_day: nicht gemeldet')
  expect(result.text).toContain('  fiveHour: nichts\n  sevenDay: nichts')
})
