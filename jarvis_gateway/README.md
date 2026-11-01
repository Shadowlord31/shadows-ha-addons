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

## Daten

`/data/settings.json` (atomar geschrieben, bei jeder Aenderung Sicherung der Vorversion, die letzten 20 bleiben),
`/data/audit.jsonl` (Protokoll, 90 Tage; Tokens werden nie geloggt). Export/Import der Einstellungen als JSON ohne Token in der Oberflaeche.
