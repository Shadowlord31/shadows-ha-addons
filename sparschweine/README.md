# Sparschweine

Eigenständiges Sparschwein-/Sparziel-Tool als Home Assistant Add-on. Eigene SQLite-Datenbank
(`/data/sparschweine.sqlite`), komplett unabhängig von anderen Apps.

## Funktionen

- Sparschweine mit Name, Farbe und optionalem Zielbetrag
- Buchungen mit ODER OHNE Sparschwein - z.B. Trinkgeld direkt tracken, ohne es einem Sparziel zuzuordnen ("Ohne Sparschwein"-Kachel)
- Kategorien für Buchungen (frei definierbar, mit Farbe)
- Sparschweine sind anklickbar → Detailansicht mit allen Buchungen, Fortschrittsbalken zum Ziel
- Ein-/Auszahlungen buchen, inkl. Kategorie-Zuordnung
- Statistik-Seite mit Monatsauswahl: Summen pro Kategorie für den gewählten Monat
- Import & Export als JSON-Datei (Backup/Restore, Übertragung auf eine andere Instanz)

## Login

Nur über Ingress nutzbar (Sidebar-Panel bzw. "Weboberfläche öffnen" in den
Add-on-Einstellungen). Kein eigenes Benutzerkonto.

## Konfiguration

Keine Optionen nötig — einfach installieren und starten.
