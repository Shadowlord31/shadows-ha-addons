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
