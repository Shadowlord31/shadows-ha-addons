# Sparschweine

Eigenständiges Sparschwein-/Sparziel-Tool als Home Assistant Add-on. Eigene SQLite-Datenbank
(`/data/sparschweine.sqlite`), unabhängig von der [finanz-app](https://github.com/Shadowlord31/finanz-app).

## Funktionen

- Sparschweine mit Name, Farbe und optionalem Zielbetrag
- Ein-/Auszahlungen buchen, Fortschrittsbalken zum Ziel
- Import aus der Finanz-App (PIN-Login, idempotent per ID — beliebig oft wiederholbar,
  keine Duplikate)

## Login

Nur über Ingress nutzbar (Sidebar-Panel bzw. "Weboberfläche öffnen" in den
Add-on-Einstellungen). Kein eigenes Benutzerkonto.

## Konfiguration

| Option | Beschreibung |
|---|---|
| `finanzapp_url` | Basis-URL der Finanz-App, z.B. `http://192.168.178.114:3007` |
| `finanzapp_pin` | PIN für den Import-Login |

Beide Felder sind optional — ohne sie funktioniert das Add-on normal, nur der
Import-Button bleibt ohne Wirkung.
