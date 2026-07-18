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

**Wichtig:** Die App ist nur über den Ingress-Zugang (Sidebar-Panel bzw. "Weboberfläche öffnen" in
den Add-on-Einstellungen) nutzbar. Ein direkter Port-Zugriff würde die Ingress-Header umgehen und
landet auf der reinen Leseansicht ohne Login.

## Konfiguration

| Option | Beschreibung |
|---|---|
| `api_token` | Beliebiges, selbst gewähltes Token für den [Companion-Integration](https://github.com/Shadowlord31/ha-shift-planner)-Zugang (siehe unten). Leer lassen, wenn die Integration nicht genutzt wird. |

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
- Ingress-only, kein exponierter Host-Port (bewusst kein `webui` in der `config.yaml`, das würde den
  Ingress-Proxy umgehen)
