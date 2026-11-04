# Shift Planner

Self-hosted Dienstplan-/Schichtplaner-App als Home Assistant Add-on: Schichten, Arbeitszeiten,
Urlaubsverwaltung mit Übertrag und persönliche Feiertags-/Ferienlisten — pro Nutzer getrennt.

Migriert von der eigenständigen [dienstplan](https://github.com/Shadowlord31/dienstplan)-Webapp
(Node/Express, vorher mit Postgres + eigenem Login).

## Funktionen

- **Dienstplan**: Monatskalender mit frei definierbaren Schichtarten (Name, Kürzel, Farbe, Standardzeiten)
- **Arbeitszeit**: Ist-Stunden pro Tag, Soll-/Ist-Vergleich, Wochen-/Monatsübersicht
- **Urlaub**: Urlaubsbudget mit Übertrag ins Folgejahr, Status (geplant/genehmigt/genommen), automatische Buchung als 8h-Arbeitszeit bei Status "genommen"
- **Statistik**: Jahresübersicht (Ist/Soll-Stunden, Urlaub, Krank-/Freizeitausgleichstage) pro Monat
- **Feiertage & Ferien**: jeder Nutzer pflegt seine eigene Liste, Import per Klick über [openholidaysapi.org](https://openholidaysapi.org) (Schulferien + gesetzliche Feiertage, alle deutschen Bundesländer, mehrere Jahre im Voraus)
- **Dashboard**: Wochenübersicht aller Nutzer auf einen Blick (auch ohne Login lesbar)

## Login: Home Assistant Ingress statt eigenem Passwort

Kein eigenes Benutzerkonto/Passwort mehr — die App erkennt den eingeloggten HA-Nutzer automatisch
über die Ingress-Header (`X-Remote-User-Id/-Name/-Display-Name`) und legt beim ersten Aufruf
selbstständig ein Profil an. Kein Admin/User-Rollenmodell: jeder identifizierte HA-Nutzer verwaltet
sowohl seine eigenen Daten als auch seine eigenen Feiertage — HA übernimmt die Benutzerverwaltung.

**Wichtig:** Die App selbst (Dienstplan bearbeiten, Urlaub eintragen, Einstellungen, …) ist nur über
den Ingress-Zugang (Sidebar-Panel bzw. "Weboberfläche öffnen" in den Add-on-Einstellungen) nutzbar.
Ein direkter Port-Zugriff (falls im Netzwerk-Tab aktiviert, siehe unten) würde die Ingress-Header
umgehen und landet auf der reinen Leseansicht ohne Login — mit Ausnahme der über `X-API-Token`
abgesicherten `/api/dp/integration/*`-Routen für externe Integrationen.

## Konfiguration

| Option | Beschreibung |
|---|---|
| `api_token` | Beliebiges, selbst gewähltes Token für den [Companion-Integration](https://github.com/Shadowlord31/ha-shift-planner)-Zugang und für externe Integrationen über den optionalen Netzwerk-Port (siehe unten). Leer lassen, wenn keins davon genutzt wird. |

## Optionaler Netzwerk-Port (für externe Integrationen im LAN)

Standardmäßig läuft das Add-on weiterhin **nur über Ingress** (kein Port exponiert). Wer einen
eigenen Dienst im LAN hat, der *nicht* über HA/Ingress läuft (z.B. einen eigenen Assistenten), kann
im Netzwerk-Tab der Add-on-Einstellungen optional einen Host-Port für `3001/tcp` setzen. Danach ist
die App zusätzlich direkt unter `http://<host>:<port>` erreichbar.

**Sicherheit:**
- Die normale Oberfläche (Dienstplan, Arbeitszeit, Urlaub, Einstellungen, …) bleibt bei direktem
  Port-Zugriff weiterhin nur als reine Leseansicht ohne Login sichtbar — ohne die Ingress-Header
  gibt es dort keinen angemeldeten Nutzer, alle schreibenden bzw. nutzerbezogenen Routen antworten
  mit 401.
- Nur die Routen unter `/api/dp/integration/*` (siehe unten) akzeptieren direkten Port-Zugriff zum
  Lesen **und Schreiben** — abgesichert über den `X-API-Token`-Header gegen das oben gesetzte
  `api_token`. Ohne oder mit falschem Token: 401. Ist kein `api_token` gesetzt: 403.
- Empfehlung: Port nur aktivieren, wenn er wirklich gebraucht wird, und `api_token` auf ein langes,
  zufälliges Token setzen.

## Integrations-API (`/api/dp/integration/*`, `X-API-Token`-Header erforderlich)

Für eigene Skripte/Automationen (z.B. einen Assistenten im LAN), die Schichten und Urlaub lesen
*und schreiben* sollen. Jede Anfrage braucht den Header `X-API-Token: <api_token>`.

| Methode & Pfad | Beschreibung |
|---|---|
| `GET /summary` | Übersicht aller Nutzer (nächste Schicht, im Dienst jetzt, Urlaub) |
| `GET /shifts?username=&start=&end=` | Schichten eines Nutzers im Zeitraum |
| `GET /shift-types?username=` | Schichtarten eines Nutzers |
| `GET /vacations?username=&year=` | Urlaube eines Nutzers (optional nach Jahr gefiltert) |
| `PUT /shift` | Schicht eines Tages anlegen/ersetzen: `{username, date, shift_type, actual_start?, actual_end?}` — `shift_type` ist Kürzel, Name oder ID |
| `DELETE /shift` | Schicht eines Tages entfernen: `{username, date}` |
| `POST /vacation` | Urlaub anlegen: `{username, start_date, end_date, status?, note?}` |
| `PATCH /vacation/:id` | Urlaub ändern (Teil-Update): `{username, start_date?, end_date?, status?, note?}` — wechselt der Status dabei auf `genommen`, wird wie in der Oberfläche automatisch 8h Arbeitszeit pro Arbeitstag gebucht |
| `DELETE /vacation/:id?username=` | Urlaub löschen |
| `POST /checkin` / `POST /checkout` / `POST /worktime` | Arbeitszeiterfassung, siehe [Companion-Integration](https://github.com/Shadowlord31/ha-shift-planner)-README |
| `GET /export` | Vollständiger, rein lesender Rohdaten-Export aller Dienstplan-Tabellen, siehe eigener Abschnitt unten |

Hinweis zu `PUT /shift`: bildet — anders als die Teilschicht-fähige Oberfläche — bewusst nur einen
einzelnen, autoritativen Schicht-Eintrag pro Tag ab (ersetzt einen evtl. vorhandenen Eintrag
vollständig, inkl. Notiz).

## Export-Format (`GET /api/dp/integration/export`)

Rein lesender Endpunkt (keine Schreibzugriffe, keine Seiteneffekte, keine Migration) — Grundlage für
eine 1:1-Übernahme der Dienstplan-Daten durch einen externen Dienst (z. B. Jarvis), bevor das Add-on
irgendwann abgeschaltet wird. Jede Tabelle wird vollständig und ungefiltert als Array mit den **rohen
Spaltennamen und -werten der SQLite-Datenbank** zurückgegeben — keine Umbenennung, keine Rundung,
keine Zeitzonenkonvertierung. Datum/Zeit stehen exakt so drin wie in der DB (`DATE` als
`YYYY-MM-DD`-Text, `TIME` als `HH:MM`- oder `HH:MM:SS`-Text, je nachdem wie der jeweilige Wert
gespeichert wurde). Jede Zeile enthält ihre unveränderte `id` als Quell-ID für einen idempotenten
Import. Die autoritative Spaltenliste ist immer `app/db/schema.sql`; unten der Stand zu Version 0.6.0.

Aufbau der Antwort:

```jsonc
{
  "version": "0.6.0",              // Add-on-Version (aus package.json)
  "exportiert_am": "2026-11-04T09:30:00.000Z",
  "zaehler": { "dp_users": 2, "dp_shift_types": 3, "dp_shifts": 142, "...": "..." },
  "dp_users": [ /* siehe unten */ ],
  "dp_shift_types": [ /* ... */ ],
  "dp_shifts": [ /* ... */ ],
  "dp_vacations": [ /* ... */ ],
  "dp_work_times": [ /* ... */ ],
  "dp_vacation_carryover": [ /* ... */ ],
  "dp_holidays": [ /* ... */ ],
  "vergleich": [ /* vom Add-on selbst berechnete Werte, siehe unten */ ]
}
```

### Tabellen (Rohdaten)

**`dp_users`** — kein Passwort/Secret enthalten (Login läuft über Ingress, nicht über diese Tabelle).

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `ha_user_id` | TEXT | HA-interne Nutzer-ID zur Ingress-Zuordnung (kein Secret/Token) |
| `username` | TEXT | HA-Login-Name |
| `display_name` | TEXT | Anzeigename |
| `vacation_budget` | INTEGER | Urlaubstage/Jahr (Altfeld, siehe `vacation_base`) |
| `vacation_base` | INTEGER | Urlaubstage/Jahr (aktuelles Feld) |
| `bundesland` | TEXT | z. B. `BY` |
| `work_days` | TEXT(7) | Arbeitstage-Muster Mo–So, z. B. `1111100` |
| `weekly_hours` | DECIMAL | Soll-Wochenstunden |
| `created_at` | TIMESTAMP | Anlage-Zeitpunkt |

Beispielzeile (erfundene Daten):
```json
{"id":1,"ha_user_id":"a1b2c3","username":"thomas","display_name":"Thomas","vacation_budget":30,"vacation_base":30,"bundesland":"BY","work_days":"1111100","weekly_hours":40,"created_at":"2026-01-02 08:00:00"}
```

**`dp_shift_types`**

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `user_id` | INTEGER | FK → `dp_users.id` |
| `name` | TEXT | voller Name der Schichtart |
| `short_name` | TEXT | Kürzel (im Kalender angezeigt) |
| `color` | TEXT | Hex-Farbe `#rrggbb` |
| `default_start` / `default_end` | TIME | Standardzeiten |
| `counts_as_work` | INTEGER | 0/1, zählt als Arbeitszeit |

Beispiel: `{"id":1,"user_id":1,"name":"Frühschicht","short_name":"FS","color":"#4f8ef7","default_start":"06:00","default_end":"14:00","counts_as_work":1}`

**`dp_shifts`** — alle Blöcke (mehrere pro Tag möglich = Teilschichten, unterschieden über `sort_order`).

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `user_id` | INTEGER | FK → `dp_users.id` |
| `shift_type_id` | INTEGER | FK → `dp_shift_types.id` (kann `null` sein) |
| `date` | DATE | `YYYY-MM-DD` |
| `sort_order` | INTEGER | Reihenfolge der Blöcke desselben Tages, beginnend bei 0 |
| `actual_start` / `actual_end` | TIME | individuelle Ist-Zeiten (sonst gilt der Default der Schichtart) |
| `note` | TEXT | Notiz |

Beispiel: `{"id":501,"user_id":1,"shift_type_id":1,"date":"2026-09-10","sort_order":0,"actual_start":"06:00","actual_end":"14:00","note":null}`

**`dp_vacations`**

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `user_id` | INTEGER | FK → `dp_users.id` |
| `start_date` / `end_date` | DATE | `YYYY-MM-DD` |
| `status` | TEXT | `geplant` \| `genehmigt` \| `genommen` \| `abgelehnt` |
| `note` | TEXT | Notiz |
| `year` | INTEGER | Zuordnungsjahr (= Jahr von `start_date`) |

Beispiel: `{"id":12,"user_id":1,"start_date":"2026-09-14","end_date":"2026-09-18","status":"genommen","note":"Herbsturlaub","year":2026}`

**`dp_work_times`** — alle Blöcke (mehrere pro Tag möglich, unterschieden über `sort_order`).

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `user_id` | INTEGER | FK → `dp_users.id` |
| `date` | DATE | `YYYY-MM-DD` |
| `sort_order` | INTEGER | Reihenfolge der Blöcke desselben Tages |
| `start_time` / `end_time` | TIME | können bei Ganztages-Typen `null` sein |
| `break_minutes` | INTEGER | Pause in Minuten |
| `planned_hours` | DECIMAL | aktuell ungenutzt, immer `null` |
| `actual_hours` | DECIMAL | Ist-Stunden (bei `vacation`/`sick`/`holiday_comp` fest `8`) |
| `is_vacation` | INTEGER | 0/1, Altfeld (aussagekräftiger: `work_type`) |
| `work_type` | TEXT | `work` \| `vacation` \| `holiday_comp` \| `sick` |
| `note` | TEXT | Notiz |

Beispiel: `{"id":900,"user_id":1,"date":"2026-09-10","sort_order":0,"start_time":"06:00","end_time":"14:00","break_minutes":30,"planned_hours":null,"actual_hours":7.5,"is_vacation":0,"work_type":"work","note":null}`

**`dp_vacation_carryover`**

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `user_id` | INTEGER | FK → `dp_users.id` |
| `year` | INTEGER | Jahr, für das der Übertrag gilt |
| `carryover` | INTEGER | übertragene Urlaubstage aus dem Vorjahr |

Beispiel: `{"id":3,"user_id":1,"year":2026,"carryover":4}`

**`dp_holidays`** — Feiertage/Ferien, pro Nutzer getrennt gepflegt.

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER | Primärschlüssel |
| `user_id` | INTEGER | FK → `dp_users.id` |
| `name` | TEXT | Name (z. B. "Sommerferien", "Tag der Arbeit") |
| `start_date` / `end_date` | DATE | `YYYY-MM-DD` |
| `type` | TEXT | `ferien` \| `feiertag` |
| `bundesland` | TEXT | kann `null` sein (bundesweit) |
| `year` | INTEGER | Jahr |

Beispiel: `{"id":77,"user_id":1,"name":"Sommerferien","start_date":"2026-07-27","end_date":"2026-09-07","type":"ferien","bundesland":"BY","year":2026}`

### `vergleich` (vom Add-on berechnete Werte, nicht roh)

Ein Eintrag pro Nutzer, mit genau den Werten, die die Oberfläche bzw. die übrigen API-Endpunkte
heute ausgeben (`vacation_remaining` = `GET /api/dp/vacations/remaining/:year`, `stats` = `GET
/api/dp/stats/:year`, jeweils für das laufende Jahr):

```json
{
  "user_id": 1,
  "username": "thomas",
  "vacation_remaining": {"budget":30,"base":30,"carryover":4,"used":5,"planned":2,"approved":0,"remaining":27,"work_days":"1111100"},
  "stats": {"year":2026,"cutoff":"2026-11-04","target_hours":1760,"target_days":220,"actual_hours":1702.5,"diff":-57.5,"sick_days":2,"holiday_comp_days":0,"vacation":{"budget":34,"base":30,"carryover":4,"genommen":5,"geplant":2,"genehmigt":0,"remaining":27},"months":[{"actual":176,"target":0,"vacation":0,"sick":0,"holiday_comp":0,"work_days":22},"..."],"weekly_hours":40,"hpd":8},
  "shifts_current_month": {"year":2026,"month":11,"count":14}
}
```

### Beispielaufruf

```bash
curl -H "X-API-Token: <api_token>" "http://<host>:<port>/api/dp/integration/export"
```

## Migration von der alten Postgres-Version

Einmaliger, rein lesender Import aus einer bestehenden Postgres-Instanz der alten `dienstplan`-Webapp:

```
POST /api/dp/migrate/postgres
{
  "host": "...", "port": 5432, "user": "...", "password": "...", "database": "dienstplan",
  "username_map": { "alter_username": "ha_username" }
}
```

`username_map` ist optional und benennt Postgres-Usernamen auf den tatsächlichen HA-Login um, damit
die automatische Ingress-Zuordnung beim ersten Login greift. Der Import räumt vorher alle Tabellen
leer (nicht wiederholt ausführen, wenn seitdem schon neue Daten in der App stehen). Feiertage waren
in der alten Version global — sie werden beim Import für jeden migrierten Nutzer dupliziert.

## Companion-Integration (Home Assistant-Entitäten)

Für Entitäten wie "nächste Schicht" oder Automationen (z.B. Zonen-Erkennung für Arbeitszeit-Buchung)
gibt es die separate Integration **[ha-shift-planner](https://github.com/Shadowlord31/ha-shift-planner)**
(über HACS installierbar). Sie spricht nicht über Ingress, sondern über das oben gesetzte `api_token`
mit dem Add-on. Details zu Entitäten und Services stehen in deren README.

## Architektur

- Node.js/Express, SQLite (`better-sqlite3`) statt Postgres — Datenbankdatei liegt unter `/data`
- Docker-Basis: `node:20-bookworm-slim` (glibc) statt Alpine/musl — `better-sqlite3` scheitert auf
  aktuellem Alpine/musl beim Laden (`fcntl64: symbol not found`, ein bekanntes Upstream-Problem)
- Ingress bleibt der primäre Zugang (bewusst kein `webui` in der `config.yaml`, das würde den
  Ingress-Proxy umgehen); der Host-Port ist rein optional und standardmäßig deaktiviert (`ports:
  {"3001/tcp": null}`), siehe "Optionaler Netzwerk-Port" oben
