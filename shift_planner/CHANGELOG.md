# Changelog

## 0.6.0

- Neuer, rein lesender Endpunkt `GET /api/dp/integration/export`: liefert alle Dienstplan-Tabellen als Rohdaten (unveraenderte Spaltennamen/-werte, IDs erhalten) plus die vom Add-on selbst berechneten Vergleichswerte (Resturlaub, Jahresstatistik, Schichtanzahl des laufenden Monats) je Nutzer unter `vergleich` -- Grundlage dafuer, dass Jarvis den Dienstplan spaeter 1:1 uebernehmen kann. Kein Schreibzugriff, kein Seiteneffekt, keine Migration.
- Jahresstatistik-Berechnung (`computeYearStats`) aus `GET /api/dp/stats/:year` nach `app/lib/shared.js` ausgelagert, damit Export und Oberflaeche exakt dieselben Werte liefern.

## 0.5.0

- Optionaler, standardmaessig deaktivierter Netzwerk-Port (`3001/tcp`, im Netzwerk-Tab aktivierbar) fuer externe Integrationen ausserhalb von Home Assistant.
- Neue schreibende `/api/dp/integration/*`-Routen: `GET shift-types`, `GET vacations`, `PUT`/`DELETE shift`, `POST`/`PATCH`/`DELETE vacation` (Status-Wechsel auf "genommen" bucht wie in der Oberflaeche automatisch 8h Arbeitszeit pro Arbeitstag).
- Gemeinsame Logik (Resturlaub-Berechnung, 8h-Buchung, Schichtart-Auflösung per Kuerzel/Name/ID) nach `app/lib/shared.js` ausgelagert.
- Fix: mehrere `ON CONFLICT(user_id,date)`-Upserts (Urlaub-Status "genommen", sowie checkin/checkout/worktime der Companion-Integration) passten seit der Teilschicht-Migration (0.4.0) nicht mehr zu einem echten Unique-Index und loesten einen SQLite-Fehler aus -- behoben.

## 0.4.0

- Teilschichten: `dp_shifts` und `dp_work_times` erlauben jetzt mehrere Bloecke pro Tag (`sort_order`) statt maximal einem Eintrag; automatische Migration bestehender Installationen.
- Dienstplan- und Arbeitszeit-Modal: mehrere Bloecke pro Tag hinzufuegen/entfernen; Kalender- und Wochenansicht zeigen alle Bloecke eines Tages.

## 0.3.1 - 0.3.2

- Dienstplan-Kalenderansicht zeigt Schichtzeiten (Start-Ende) statt nur dem Kuerzel.
- Dienstplan und Arbeitszeit zeigen durchgehende Wochen auch ueber Monatsgrenzen hinweg (Randtage mit echten Daten statt leerer Platzhalter).

## 0.3.0

- Arbeitszeit-Erfassung (`checkin`/`checkout`/`worktime`) fuer die Home-Assistant-Integration.

## 0.2.0

- `on_vacation_now` und Kalender-Endpunkt fuer die Home-Assistant-Integration.

## 0.1.0 - 0.1.9

- Erste Version (Migration von der eigenstaendigen `dienstplan`-Webapp auf SQLite + Ingress-Login), danach diverse Fixes: API-Token-Endpunkt, Ferien-Import auf openholidaysapi.org, Zeitzonen-Bug in der Postgres-Migration, Kalender-Grid auf dem Handy, Ingress-Pfad-Praefix.
