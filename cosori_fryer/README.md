# Cosori Fryer

Bindet die **Cosori Dual Blaze TwinFry (CAF-TF101S)** per VeSync-Cloud in Home Assistant ein,
weil die eingebaute VeSync-Integration dieses Modell nicht kennt. Die Entitäten entstehen
automatisch per MQTT-Discovery (Mosquitto-Add-on, Zugangsdaten liefert Supervisor).

## Entitäten (je Zone 1, Zone 2 und Grandzone)
- Select: Modus (AirFry, Bake, Roast, Grill, Dry, Reheat)
- Number: Temperatur (°C, 5er-Schritte), Zeit (Minuten)
- Buttons: Programm senden, Beenden; dazu "Beide Zonen senden/beenden"
- Sensoren: Status, Restzeit, gesetzte Temperatur, gesetzte Zeit, "Letzte Meldung"

## Ablauf in Scripts
1. `number.set_value` / `select.select_option` für Zone 1 und/oder 2
2. `button.press` auf "Zone N Programm senden" bzw. "Beide Zonen senden"
3. Das Programm steht am Gerät bereit (EU-Sicherheitsnorm). **Gestartet wird immer per Taste am Gerät.**

## Optionen
- `vesync_email`, `vesync_password`: VeSync-Konto
- `country_code`: z. B. `DE`
- `poll_interval`: Status-Abfrage in Sekunden (Standard 30)
- `mqtt_host`/`mqtt_port`/`mqtt_user`/`mqtt_password`: optional, nur wenn der Broker nicht automatisch erkannt wird

## Hinweise
- Grandzone = beide Zonen zusammen (ein Programm für den ganzen Garraum). Nicht gleichzeitig mit Zone 1/2 nutzen.
- AirFry, Bake, Roast und Reheat werden von der Cloud angenommen. Dry und Grill lehnen Werte außerhalb ihres Bereichs ab
  (Fehlercode steht in "Letzte Meldung"); die gültigen Bereiche je Modus stehen in der VeSync-App.
- pyvesync wird aus einem festen Commit des Dual-Blaze-Entwicklungszweigs installiert (siehe Dockerfile).
