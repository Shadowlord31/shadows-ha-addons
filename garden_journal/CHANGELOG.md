# Changelog

## 0.1.0

- Initial scaffold, not yet functional (see repo README / issues)

## 0.2.0

- SQLite statt Postgres (better-sqlite3), kein externer DB-Server mehr noetig
- MQTT komplett entfernt (Broker, Settings-UI, alle Topics/Handler) - unnoetig innerhalb von Home Assistant
- CORS-Middleware entfernt (Ingress ist same-origin)
- PWA-Layer entfernt (Service Worker, manifest.json)
- Postgres-Setup-Wizard entfernt, App ist beim ersten Start direkt einsatzbereit
- Fruchtfolge-Pruefung von Postgres-Funktion nach JavaScript portiert
- Noch nicht funktional als Add-on: Ingress ist in config.yaml aktiviert, aber die begleitenden
  Lovelace-Karten sprechen noch eine feste api_base an statt der Ingress-URL (naechster Schritt)

## 0.2.1

- Fix: Docker-Build schlug fehl (apk-Paketkonflikt bei musl/musl-dev in ghcr.io/hassio-addons/base)
- Basis-Image auf node:20-alpine umgestellt, s6-overlay-Service-Skript entfernt (init: false nutzt das Dockerfile-CMD direkt ohne Supervisor-Init-Wrapper)
- Lokal erfolgreich gebaut und funktional getestet (Container-Start + API-Call)

## 0.2.2

- Fix: build.yaml wird von dieser Supervisor-Version komplett ignoriert (deprecated) -
  Supervisor nutzte dadurch sein eigenes Default-Basis-Image ohne npm statt node:20-alpine
- build.yaml entfernt, Basis-Image jetzt als Default direkt im Dockerfile (ARG BUILD_FROM=node:20-alpine)

## 0.2.3

- Toten Datenbankverbindung-Button samt Modal aus der Web-UI entfernt (Relikt des
  entfernten Postgres-Setup-Wizards, haette bei Klick nur einen Fehler geworfen)
- Lokal erneut vollstaendig getestet (Build + Container-Start + HTML-Laden + API-Call)

## 0.2.4

- Fix: API-Aufrufe der App nutzten absolute Pfade (`/garten/api/...`), die unter Ingress
  den Praefix-Token ignorierten und ins Leere liefen ("Beet anlegen" etc. schlugen fehl,
  obwohl direkte API-Aufrufe funktionierten). Auf relative Pfade umgestellt.
- Fix: showToast() nutzte textContent statt innerHTML, HTML-Entities (z.B. &#10060;) wurden
  dadurch woertlich statt als Symbol angezeigt

## 0.2.5

- Temporaerer Migrations-Endpunkt: POST /garten/api/admin/migrate/postgres
  (liest einmalig aus einer bestehenden Postgres-Gartentagebuch-Instanz, leert vorher
  die lokale SQLite-DB, schreibt alle Tabellen 1:1 mit identischen IDs neu)
- Lokal erfolgreich gegen echte Produktivdaten getestet (23 Beete, 26 Pflanzen,
  36 Eintraege, 7 Gehoelze, 156 Kosten-Eintraege - alle Werte nach Migration verifiziert)
- Wird nach erfolgreicher Migration auf den Zielsystemen wieder entfernt (nur fuer den
  einmaligen Umzug gedacht, kein Dauerfeature)

## 0.3.0

- Tagebuch umgebaut: Tabs "Gepflanzt/Geerntet/Dauerhaft" durch einen einzigen Tab
  "Pflanzen" ersetzt - jede Pflanze taucht nur noch einmal pro Jahr auf (gruppiert
  nach plant_id), mit Status-Badges (Geplant/Gepflanzt/Nx Teilernte/Final geerntet/Dauerhaft)
- Tippen auf eine Pflanze oeffnet Detailansicht mit der kompletten Jahres-Historie
  (alle Pflanzungen, alle Ernten mit Menge) - Datum pro Ereignis nachtraeglich
  aenderbar, einzelne Ereignisse loeschbar
- Lokal gegen echte migrierte Produktivdaten getestet (18 Pflanzengruppen korrekt
  gebildet, u.a. mehrfach gepflanzte und final geerntete Pflanzen richtig erkannt)

## 0.3.1

- Filterleiste im Tagebuch entfernt (Suche, Beet-Filter, Jahr-Filter) - unnoetig
  geworden durch den neuen "Pflanzen"-Tab, der ohnehin nur das aktuelle Jahr zeigt
- Betrifft auch den Planung-Tab (zeigt jetzt immer alle Planungen des Jahres,
  ungefiltert) - die Filterfunktionen waren defensiv genug programmiert, dass
  keine weiteren Codeaenderungen noetig waren

## 0.3.2

- Gehoelze-Tab nach demselben Muster wie der Pflanzen-Tab umgebaut: Karten zeigen
  nur noch Kurzinfo/Badges (Nx Teilernte, Final geerntet, Gerodet), Aktionen
  (Ernte erfassen, Bearbeiten, Roden, Loeschen) wandern in eine Detailansicht
  mit der Ernte-Historie des aktuellen Jahres (Datum pro Ernte nachtraeglich
  aenderbar, einzelne Ernten loeschbar)
- Fix: Ernten fuer Gehoelze setzen jetzt perennial_id auf dem Entry (fehlte bisher),
  fuer zuverlaessige Zuordnung in der Detailansicht

## 0.3.3

- Planung-Tab nach demselben Muster wie Pflanzen/Gehoelze umgebaut: Karten zeigen
  nur noch Kurzinfo (Nx geplant / Nx erledigt) pro Pflanze, gruppiert nach plant_id -
  gleiche Pflanze mehrfach verplant erscheint nur einmal
- Detailansicht listet jede einzelne Planung (Beet, Monat, Notiz, Status) mit
  Bearbeiten/Erledigt-Toggle/Loeschen
- Damit folgen jetzt alle drei Tagebuch-Tabs (Pflanzen, Gehoelze, Planung) demselben
  Karte-plus-Detailansicht-Schema
