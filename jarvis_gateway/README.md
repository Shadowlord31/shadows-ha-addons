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

### Hinweise fuer Jarvis

Pro Entitaet gibt es ein optionales Feld `hint` (Freitext, max. 300 Zeichen) und bei Aktionen mit Auswahlparameter
(z. B. `input_select.select_option`, `climate.set_hvac_mode`) eine kurze Erklaerung je erlaubter Option (max. 80 Zeichen).
Jarvis bekommt sie in `GET /entities` und `GET /entities/{id}` als `"hint"` (Text oder `null`) und in
`actions.<aktion>.params.<param>.option_hints` (nur fuer aktuell erlaubte Optionen). Gespeichert und ausgeliefert wird reiner Text:
HTML-Tags und Steuerzeichen werden entfernt, zu lange Texte abgelehnt (400). `/call` aendert sich nicht, Hinweise gelangen nie an Home Assistant.

```json
{"entity_id":"input_select.modus","hint":"Hausmodus","actions":{"select_option":{"params":{"option":
  {"allowed":["Google","Musik","Aus"],"option_hints":{"Google":"Fernsehen, Streaming, Netflix, YouTube","Musik":"Radio im Wohnzimmer","Aus":"alles aus"}}}}}}
```

### Geraetetypen und Aktionen

Jede Aktion ist fest einem Home-Assistant-Service zugeordnet, Parameter stehen auf einer Positivliste; freie Services oder Texte werden nie durchgereicht.

| Domain | Aktionen (Parameter) |
|---|---|
| light | turn_on (brightness_pct, color_temp_kelvin, rgb_color, effect), turn_off, toggle |
| switch, input_boolean | turn_on, turn_off, toggle |
| climate | turn_on, turn_off, set_temperature, set_hvac_mode, set_preset_mode, set_fan_mode |
| cover | open, close, stop, set_cover_position |
| media_player | turn_on, turn_off, play, pause, next, previous, volume_set, volume_mute, volume_up, volume_down, select_source (source) |
| fan | turn_on, turn_off, set_percentage, set_preset_mode |
| vacuum | start, pause, return_to_base, stop, locate |
| lock | lock, unlock |
| script | turn_on (konfigurierte Felder → `variables`) |
| scene, button, input_button | turn_on / press |
| automation | trigger, turn_on, turn_off (Standard ab Rolle `erwachsen`) |
| input_number, number | set_value (value) |
| input_select, select | select_option (option) |
| remote | turn_on (optional activity), turn_off |
| humidifier | turn_on, turn_off, set_humidity (0-100), set_mode (mode) |
| siren | turn_on, turn_off (Standard ab Rolle `erwachsen`) |
| input_datetime | set_datetime (time, HH:MM, auf Zeitraum begrenzbar) |

Auswahlwerte (Quelle, Modus, Effekt, Aktivitaet ...) stammen aus den Attributen der Entitaet und lassen sich je Entitaet einschraenken. Alle anderen Domains
(text, notify, camera, alarm_control_panel ...) sind **nur lesbar**; die Oberflaeche kennzeichnet das, "steuern" wird dort zu "lesen".
Bestehende Konfigurationen werden nie veraendert: neue Aktionen sind dort zunaechst aus, neue lesbare Attribute bestehender Domains standardmaessig abgewaehlt.

### Skript-Felder

Im Editor eines Skripts lassen sich Felder anlegen (Name `a-z0-9_`, Typ Auswahl mit erlaubten Werten / Zahl mit min und max / Ja-Nein, optional Pflicht, max. 20).
`turn_on` reicht genau diese Felder als `variables` weiter; Typ und Grenzen werden wie bei anderen Parametern geprueft (`invalid_param`, `value_out_of_range`, `missing_param`), unbekannte Felder abgelehnt (`unknown_param`).
Die Felder erscheinen in `/entities` unter `actions.turn_on.params`.

### Sammelaufruf (`/call_many`)

`{entity_ids (max. 30) ODER area + domain, action, params, role, person}`. Jede Entitaet wird einzeln wie `/call` geprueft (Freigabe, Aktion, Parameter, Grenzen, Rolle, Ruhezeit),
mit einem eigenen Servicecall ausgefuehrt und einzeln protokolliert. Antwort immer 200 mit
`{"results":[{"entity_id":"...","ok":true,"state_after":{...}},{"entity_id":"...","ok":false,"error":"...","code":"read_only"}]}`; ein Fehler stoppt die anderen nicht.
Fehler der ganzen Anfrage: 400 `invalid_request` / `too_many_entities`, 404 `not_found` (Bereich ohne Treffer). Bei Bereich + Domain werden nur freigegebene Entitaeten beruecksichtigt.

```bash
curl -H "X-API-Token: $T" -H 'Content-Type: application/json' \
  -d '{"area":"Küche","domain":"light","action":"turn_off","role":"erwachsen","person":"Thomas"}' $B/call_many
```

## API `/api/v1` (Header `X-API-Token`)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | `{ok, ha_connected, ha_version, entities_exposed}` (200 auch bei HA-Ausfall, dann `ok:false`) |
| GET | `/areas` | Raeume |
| GET | `/entities?area=&domain=&q=` | freigegebene Entitaeten |
| GET | `/entities/{id oder Name}` | eine Entitaet |
| GET | `/history?entity_id=&start=&end=&interval=raw\|hour\|day` | Verlauf einer freigegebenen Entitaet (lesen oder steuern) |
| POST | `/call` | `{entity_id oder name, action, params, role, person}` |
| POST | `/call_many` | `{entity_ids (max. 30) oder area + domain, action, params, role, person}` → `{results:[...]}` |

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
