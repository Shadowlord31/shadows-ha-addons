# Changelog

## 0.4.1

- Oberflaeche: Live-Zaehler (z. B. „0/300“) unter dem Feld „Hinweis fuer Jarvis“ und neben jeder Optionserklaerung (Limit 80); bei Ueberschreitung rot. Das Eingabelimit des Browsers entfaellt, damit die Ueberschreitung sichtbar wird; der Server lehnt zu lange Texte weiterhin ab

## 0.4.0

- Neue Domains: `select`, `number`, `remote`, `input_button`, `humidifier`, `siren` (Mindestrolle `erwachsen`), `input_datetime` (`set_datetime` mit Uhrzeit HH:MM, auf Zeitraum begrenzbar)
- Neue Aktionen: `media_player` turn_on/turn_off/select_source/volume_up/volume_down, `climate` turn_on/turn_off/set_fan_mode, `vacuum` stop/locate, `fan` set_preset_mode, `light` Parameter `effect` (nur bei turn_on), `automation` turn_on/turn_off (Mindestrolle `erwachsen`, `trigger` unveraendert)
- Auswahlparameter (Quelle, Luefterstufe, Effekt, Aktivitaet, Modus ...) kommen aus den Attributen, sind je Entitaet einschraenkbar und unterstuetzen `option_hints`; optionale Auswahlparameter ohne erlaubte Werte werden nicht angeboten
- Skript-Felder: pro Skript optionale Felder (Auswahl mit erlaubten Werten, Zahl mit min/max, Ja/Nein, optional Pflicht), die bei `script.turn_on` als `variables` weitergegeben werden; strenge Pruefung, unbekannte Felder abgelehnt; Editor in der Oberflaeche, Ausgabe in `/entities` wie andere Parameter
- Neuer Endpunkt `POST /api/v1/call_many` (max. 30 Entitaeten oder Bereich + Domain): jede Entitaet wird wie `/call` geprueft, einzeln ausgefuehrt und protokolliert; Teilerfolge moeglich
- Oberflaeche: neue Typen in Editor, Sammelaktion, Assist-Uebernahme und Standardwerten; nicht steuerbare Domains (text, notify, camera, alarm_control_panel ...) sind als „nur Lesen“ gekennzeichnet
- Neue lesbare Attribute bestehender Domains (`source`, `source_list`, `fan_mode`, `fan_modes`, `effect`, `effect_list`, `preset_modes`) sind waehlbar, aber standardmaessig aus; bestehende Konfigurationen bleiben unveraendert (neue Aktionen dort zunaechst deaktiviert)

## 0.3.0

- Hinweistexte fuer Jarvis: pro Entitaet `hint` (max. 300 Zeichen) und je Option bei choice-Parametern `option_hints` (max. 80 Zeichen, nur erlaubte Optionen); Eingabe im Entitaeten-Editor, Ausgabe in `GET /entities` und `GET /entities/{id}`; reiner Text (HTML und Steuerzeichen werden entfernt); in Export/Import enthalten, alte Dateien ohne diese Felder bleiben gueltig

## 0.2.0

- Neuer Endpunkt `GET /api/v1/history` (Verlaufsdaten, `interval=raw|hour|day`, max. 31 Tage, Tagesgrenzen in Europe/Berlin inkl. Zeitumstellung); nur fuer Entitaeten mit Zugriff lesen/steuern, ohne Attribute, mit Audit-Eintrag

## 0.1.0

- Erste Version: Token-API `/api/v1` (health, areas, entities, call) fuer Jarvis
- Ingress-Oberflaeche: Entitaetenliste mit Filtern, Sammelaktion, Uebernahme aus Assist (mit Vorschau), Einstellungen pro Entitaet
- Aktionsvorlagen je Domain mit Wertgrenzen, Rollen, Bestaetigungsstufe, Ruhezeiten
- Protokoll (90 Tage), Export/Import der Einstellungen, automatische Sicherungen (letzte 20)
