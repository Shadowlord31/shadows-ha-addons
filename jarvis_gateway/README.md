# Jarvis Gateway

Schleuse zwischen dem Sprachassistenten Jarvis (extern, im LAN) und Home Assistant.
Jarvis bekommt **kein** HA-Token, sondern nur das Add-on-Token. Er sieht und steuert
ausschliesslich Entitaeten, die in der Oberflaeche explizit freigegeben wurden.

## Einrichtung

1. Add-on installieren und starten.
2. In der Konfiguration `api_token` setzen (lang und zufaellig, z. B. `openssl rand -hex 32`).
3. Unter *Netzwerk* den Port **3003** aktivieren (standardmaessig aus).
4. Oberflaeche oeffnen (Seitenleiste „Jarvis Gateway"): Entitaeten freigeben, entweder einzeln, per Sammelaktion
   oder ueber **Aus Assist uebernehmen** (Vorschau, nichts wird ohne Bestaetigung geaendert, bestehende Eintraege bleiben unveraendert).
5. Jarvis auf `http://<HA-IP>:3003/api/v1` mit Header `X-API-Token` konfigurieren.

## Zugriffsschutz

- Ingress (Oberflaeche) ist offen, erkannt ueber die Supervisor-Gateway-Adresse (`INGRESS_GATEWAY_IPS`, Standard `172.30.32.2`).
- Direkter Port: nur `/api/v1/*` und nur mit gueltigem `X-API-Token` (konstante Vergleichszeit). Ohne Token 401, bei leerem `api_token` 403.
- Rate-Limit 120 Anfragen/Minute je Quelladresse, Body-Limit 16 KB.

## Pro Entitaet

Zugriff (aus / lesen / steuern), Sprachname, Aliase, Raum, erlaubte Aktionen mit Wertgrenzen,
Bestaetigungsstufe 0/1/2, Mindestrolle (`all`/`erwachsen`/`admin`, wird vom Gateway selbst erzwungen),
optionale Ruhezeiten (Europe/Berlin), lesbare Attribute (feste Positivliste je Domain; bei `person` nur der Zustand).

Standard beim Anlegen: `sensor`, `binary_sensor`, `weather` nur lesen; steuerbare Domains mit allen Vorlagen-Aktionen;
`lock` mit Bestaetigung 2, Mindestrolle `erwachsen`.

## API `/api/v1` (Header `X-API-Token`)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | `{ok, ha_connected, ha_version, entities_exposed}` (200 auch bei HA-Ausfall, dann `ok:false`) |
| GET | `/areas` | Raeume |
| GET | `/entities?area=&domain=&q=` | freigegebene Entitaeten |
| GET | `/entities/{id oder Name}` | eine Entitaet |
| GET | `/history?entity_id=&start=&end=&interval=raw\|hour\|day` | Verlauf einer freigegebenen Entitaet (lesen oder steuern) |
| POST | `/call` | `{entity_id oder name, action, params, role, person}` |

Pruefreihenfolge bei `/call`: freigegeben (`not_exposed`) → Steuerzugriff (`read_only`) → Aktion erlaubt (`action_not_allowed`) →
Parameter bekannt (`unknown_param`) → Typ und Grenzen (`value_out_of_range`, kein stilles Klemmen) → Rolle (`role_too_low`) →
Ruhezeit (`quiet_hours`). Mehrdeutige Namen: 409 `ambiguous_name` mit Vorschlaegen. Es wird genau ein Servicecall mit nur dieser `entity_id` ausgefuehrt.
Fehler: `{"error": "...", "code": "..."}`.

```bash
T=dein-token; B=http://homeassistant.local:3003/api/v1
curl -H "X-API-Token: $T" $B/health
curl -H "X-API-Token: $T" "$B/entities?area=Küche&domain=light"
curl -H "X-API-Token: $T" -H 'Content-Type: application/json' \
  -d '{"name":"Küche Licht","action":"turn_on","params":{"brightness_pct":40},"role":"erwachsen","person":"Thomas"}' $B/call
```

### Verlauf (`/history`)

- `start`/`end`: ISO-8601, Standard letzte 24 h, maximal 31 Tage (sonst 400 `range_too_large`). Ohne Zeitzonenangabe gilt Europe/Berlin; ein `+` im Offset in der URL als `%2B` schreiben.
- `interval=raw`: `{t, state}`, hoechstens 5000 Punkte (sonst 413 `too_many_points`, dann `hour`/`day` nehmen).
- `interval=hour|day`: nur numerisch; je Fenster `{t, min, max, mean, first, last, count}`. `mean` ist der Mittelwert der aufgezeichneten Zustandswerte (nicht zeitgewichtet). Tagesfenster in Europe/Berlin (23/25-Stunden-Tage bei Zeitumstellung korrekt), `t` = Fensterbeginn mit Offset. `unavailable`/`unknown` werden ignoriert, Fenster ohne Werte fehlen; andere Texte ergeben 400 `not_numeric`.
- Der Kopf enthaelt `unit_of_measurement`, falls dieses Attribut fuer die Entitaet freigegeben ist. Es werden nie Attribute ausgegeben.

```bash
# Regen je Tag der letzten 7 Tage
curl -H "X-API-Token: $T" "$B/history?entity_id=sensor.regen_heute&interval=day&start=2026-10-26&end=2026-11-02"
# Temperaturverlauf stuendlich, gestern
curl -H "X-API-Token: $T" "$B/history?entity_id=sensor.aussentemperatur&interval=hour&start=2026-11-01&end=2026-11-02"
```

## Daten

`/data/settings.json` (atomar geschrieben, bei jeder Aenderung Sicherung der Vorversion, die letzten 20 bleiben),
`/data/audit.jsonl` (Protokoll, 90 Tage; Tokens werden nie geloggt). Export/Import der Einstellungen als JSON ohne Token in der Oberflaeche.
