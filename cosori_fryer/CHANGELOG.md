# Changelog

## 0.2.0
- Grandzone (beide Zonen zusammen, workChamber 3) mit eigenen Entitäten: Modus, Temperatur, Zeit, Senden, Beenden, Status, Restzeit.
- Status wird direkt aus der Cloud-Antwort gelesen (inkl. Grandzone); bei aktiver Grandzone zeigen Zone 1/2 "Grandzone".
- Temperaturbereich 35-240 °C und Zeit bis 720 min: Die Cloud entscheidet, was für den Modus gültig ist (Dry/Grill lehnten 180 °C ab).
- Abgelehnte Befehle melden Modus, Temperatur, Zeit und Cloud-Code; die Verbindung wird dabei nicht mehr neu aufgebaut (behebt "Session is closed").
- "Letzte Meldung" zeigt nach einem Verbindungsfehler wieder "Verbunden".

## 0.1.0
- Erste Version: MQTT-Discovery für Cosori Dual Blaze (CAF-TF101S), je Zone Modus/Temperatur/Zeit, Senden/Beenden, Status und Restzeit.
