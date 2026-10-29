# kontext-cache-band

Claude-Code-Mod, der im Band über dem Eingabefeld zwei gleich aufgebaute Zeilen zeigt, im Terminal und im Code-Tab der Claude-Desktop-App:

```
Kontext  █████████░░░░░░░┃░░░   45 %  90k von 200k              Auto-Compact bei 167k (84 %), noch 77k
Cache    ████████████████████  58:30  95 % Treffer · 89k (85k gelesen, 4k neu)      TTL 1h, Abo-Standard
```

- **Kontext**: Füllstand des Kontextfensters (Werte der letzten Antwort, wie die Statuszeile sie hat). Die Marke `┃` im Balken ist die Auto-Compact-Schwelle. Der Balken ist grün, gelb ab 5 Punkten vor der Schwelle und rot ab 90 %. Dahinter die Token, rechtsbündig Schwelle und Abstand zur Schwelle, oder „Auto-Compact aus“; ein gesetztes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` steht am Ende.
- **Cache**: Der Balken ist die Restzeit bis zum Ablauf des Caches: voll direkt nach einer Anfrage, er leert sich über die Lebensdauer (1 Stunde oder 5 Minuten). Grün, in der letzten Minute gelb; abgelaufen ist er leer, daneben steht rot „kalt“ und wie lange schon. Dahinter die Trefferquote der letzten Anfrage und die Token, rechtsbündig die Lebensdauer und ihre Quelle. Als Treffer zählen nur die aus dem Cache gelesenen Token, abgerundet; neu in den Cache geschriebene Token sind keine Treffer. Eine Anfrage auf kalten Cache zeigt deshalb 0 % (oder nahe 0 %). Ist der Cache abgelaufen, steht „zuletzt“ davor, weil die Quote nur für die letzte Anfrage gilt. Bei einem fortgesetzten Gespräch ist sie unbekannt und fehlt, bis die erste Anfrage gelaufen ist. In einem laufenden Gespräch ist die Quote meist hoch, weil jede Anfrage den bisherigen Verlauf aus dem Cache liest; deshalb zeigt der Balken die Restzeit, die sich tatsächlich ändert.

Die drei vorderen Spalten haben feste Breiten, damit die Balken übereinander stehen. Im Terminal sind die Balken aus Blockzeichen; die Desktop-App zeichnet mit Proportionalschrift, dort sind es abgerundete Grafik-Balken (Marke als senkrechter Strich). Unter 90 Zeichen Breite werden die Balken kürzer, die Einzelheiten brechen um.

## Cache warm halten: `/cache-keep-warm`

Hält den Prompt-Cache des Gesprächs für ein Zeitfenster warm, etwa über eine Mittagspause.

```
/cache-keep-warm 2h        # auch 90m, 90 (Minuten), 1h30m, 1,5h, 1:30; höchstens 24 h
/cache-keep-warm           # ohne Angabe 1 h; läuft es schon, zeigt es den Stand
/cache-keep-warm stop      # beendet (auch: aus, ende); oder „Beenden“ im Band
```

Kurz vor jedem Ablauf (5 min vorher bei 1 h Lebensdauer, 1 min vorher bei 5 min) schickt der Mod die letzte Anfrage des Gesprächs mit `$.model.fork` noch einmal ab. Die API liest sie aus dem Cache, und jeder Treffer setzt die Lebensdauer ohne Aufpreis neu. Das Gespräch selbst bekommt keine Nachricht dazu. Hält der Cache ohnehin bis zum Fensterende, wird nicht mehr aufgefrischt.

Solange es läuft, zeigt das Band eine dritte Zeile (ohne Bezeichnung, unter den Balken eingerückt) mit Restzeit des Fensters, Zahl der Auffrischungen, nächster Auffrischung und dem Knopf „Beenden“. Es endet von selbst mit dem Fenster, nach `/clear` oder einem Gesprächswechsel, und wenn es nichts mehr aufzufrischen gibt. Schlägt eine Auffrischung fehl, steht das in der Zeile, und nach 30 Sekunden folgt ein neuer Versuch.

Kosten: Jede Auffrischung liest den ganzen Kontext aus dem Cache (zum Cache-Lesepreis, laut Anthropic ein Bruchteil des normalen Eingabepreises) und zählt im Abo zur Nutzung. Bei 1 h Lebensdauer ist das etwa eine Auffrischung pro Stunde, bei 5 min rund zwölf. Ist der Cache beim Start schon abgelaufen, baut die erste Auffrischung ihn neu auf, das kostet einmal einen Schreibvorgang. Läuft der Rechner nicht (Ruhezustand, App geschlossen), wird nicht aufgefrischt.

## Wann sich die Anzeige aktualisiert

- Nach jeder Modellanfrage des Hauptgesprächs (oft mehrmals pro Runde): beide Zeilen.
- Nach jeder Runde und wenn sich ein Nutzungsfenster bewegt: Kontext und Auto-Compact.
- Jede Sekunde, solange der Cache warm ist: die Restzeit. Danach einmal pro Minute „kalt seit … min“.
- Nach geänderten Einstellungen, einem Modellwechsel, `/clear`, einem Gesprächswechsel und einer Komprimierung: sofort.

Vor der ersten Antwort, nach `/clear` und nach einer Komprimierung gibt es keinen gemessenen Kontextwert. Dann zeigt die Zeile Claude Codes Schätzung mit `≈` und „(geschätzt)“. Während eine einzelne Antwort noch läuft, steht die Zeile auf dem Stand der vorigen Anfrage, weil die API die Token erst am Ende meldet.

## Wie die Cache-Restzeit berechnet wird

Claude Code meldet die Restzeit nicht direkt. Der Mod merkt sich bei jeder Anfrage des Hauptgesprächs den Zeitpunkt und die Cache-Lebensdauer, die dabei galt, und zählt von dort herunter.

Rangfolge der Lebensdauer: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, Einstellung `promptCacheTtl`, `ENABLE_PROMPT_CACHING_1H` (laut Claude-Code-Doku). Ohne eigene Einstellung: ausgeschöpftes Abo-Fenster 5 Minuten („Zusatznutzung, vermutet“), sonst der Wert, den Claude Code selbst gemeldet hat („von Claude Code gemeldet“, bei Modellwechsel und beim Fortsetzen eines Gesprächs), sonst 1 Stunde im Abo und 5 Minuten ohne Abo.

Beim Fortsetzen eines Gesprächs schätzt der Mod den Cache-Stand aus Claude Codes Angaben (Zeit seit der letzten Antwort, Kontextgröße, ob der Cache vermutlich abgelaufen ist) und kennzeichnet ihn mit `≈`.

Grenzen:

- Nur Anfragen des Hauptgesprächs zählen. Subagenten haben einen eigenen Cache. Prompt-Vorschläge, Forks und andere Nebenanfragen können den Cache etwas länger warm halten, als der Countdown zeigt.
- Zusatznutzung erkennt der Mod nur indirekt. Sicher wird die Anzeige mit einer eigenen `promptCacheTtl`-Einstellung.

## Installieren

In einer Terminal-Sitzung von Claude Code eingeben:

```
/plugin install kontext-cache-band --marketplace marcomarkl/kontext-cache-band
```

Danach `y`, um den Marktplatz hinzuzufügen, und einen Geltungsbereich wählen. Bei einem privaten Repository braucht der Rechner Zugriff auf GitHub (angemeldetes `gh` oder Git-Zugangsdaten).

In der Desktop-App: **+** neben dem Eingabefeld, **Plugins**, **Add marketplace** mit `marcomarkl/kontext-cache-band`, dann **Add plugin**.

## Aus einem Ordner laden (Entwicklung)

Ordner dauerhaft für alle Sitzungen der Desktop-App und des Terminals: in `~/.claude/settings.json`

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Pfad/zu/kontext-cache-band" } }
```

Einmalig im Terminal: `claude --plugin-dir /Pfad/zu/kontext-cache-band`

Braucht Claude Code 2.1.287 oder neuer (Desktop-App: 2.1.286), geprüft mit 2.1.312.
