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

Hinweis zu `PUT /shift`: bildet — anders als die Teilschicht-fähige Oberfläche — bewusst nur einen
einzelnen, autoritativen Schicht-Eintrag pro Tag ab (ersetzt einen evtl. vorhandenen Eintrag
vollständig, inkl. Notiz).

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
