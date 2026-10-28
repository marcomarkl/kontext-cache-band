/** Die letzte Modellanfrage des Hauptgesprächs, wie die API sie abgerechnet hat. */
export type LastRequest = {
  /** Wann die Anfrage abging, in Millisekunden seit der Epoche. */
  at: number
  /** Nicht gecachte Eingabe-Token. */
  input: number
  /** Aus dem Cache gelesene Token. */
  read: number
  /** In den Cache geschriebene Token. */
  write: number
  /** Cache-Lebensdauer, die für diese Anfrage galt, in Millisekunden. */
  ttlMs: number
  /** Woher diese Lebensdauer kommt, als kurzer Text. */
  ttlSource: string
  /** Wahr, wenn die Werte aus einem fortgesetzten Gespräch geschätzt sind. */
  isEstimate?: boolean
}

/** Was die Sitzung über Kontext und Auto-Compact meldet. */
export type SessionInfo = {
  /** Token im Kontext; fehlt, wenn weder gemessen noch geschätzt. */
  tokens?: number
  /** Kontextfenster des Modells in Token. */
  window: number
  /** tokens / window in Prozent. */
  percent?: number
  /** Wahr, wenn tokens geschätzt ist (vor der ersten Antwort, nach /clear oder Komprimierung). */
  isEstimated?: boolean
  /** Ob Auto-Compact für die Sitzung an ist; fehlt, wenn Claude Code es nicht gemeldet hat. */
  isAutoCompactOn?: boolean
  /** Token-Zahl, ab der Auto-Compact läuft; fehlt, wenn es aus ist. */
  autoCompactAt?: number
  /** Wert von CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, falls gesetzt. */
  autoCompactOverride?: string
  /** Ob Prompt-Caching abgeschaltet ist. */
  isCachingOff: boolean
}

/** Die Cache-Lebensdauer, wie Claude Code selbst sie zuletzt gemeldet hat. */
export type TtlHint = {
  ms: number
}

/** Läuft /cache-keep-warm: Zeitfenster und Stand der Auffrischungen. */
export type WarmState = {
  /** Beginn, in Millisekunden seit der Epoche. */
  startedAt: number
  /** Ende des Zeitfensters, in Millisekunden seit der Epoche. */
  until: number
  /** Erfolgreiche Auffrischungen seit dem Start. */
  pings: number
  /** Nach einem Fehler: frühester nächster Versuch. */
  nextTryAt?: number
  /** Kurzer Text zum letzten Fehler. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'kontext-cache-band': {
      last: Shaped<LastRequest | null>
      info: Shaped<SessionInfo | null>
      ttlHint: Shaped<TtlHint | null>
      warm: Shaped<WarmState | null>
    }
  }
}
