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
