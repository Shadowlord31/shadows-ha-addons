# Changelog

## 0.2.0

- Neuer Endpunkt `GET /api/v1/history` (Verlaufsdaten, `interval=raw|hour|day`, max. 31 Tage, Tagesgrenzen in Europe/Berlin inkl. Zeitumstellung); nur fuer Entitaeten mit Zugriff lesen/steuern, ohne Attribute, mit Audit-Eintrag

## 0.1.0

- Erste Version: Token-API `/api/v1` (health, areas, entities, call) fuer Jarvis
- Ingress-Oberflaeche: Entitaetenliste mit Filtern, Sammelaktion, Uebernahme aus Assist (mit Vorschau), Einstellungen pro Entitaet
- Aktionsvorlagen je Domain mit Wertgrenzen, Rollen, Bestaetigungsstufe, Ruhezeiten
- Protokoll (90 Tage), Export/Import der Einstellungen, automatische Sicherungen (letzte 20)
