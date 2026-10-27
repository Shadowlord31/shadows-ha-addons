# Changelog

## 0.2.2
- Adaptives Polling: im Ruhezustand alle `poll_interval` Sekunden (Standard 60), solange ein Programm gesetzt ist oder läuft alle 20 s.
- Bei einem VeSync-Rate-Limit pausiert das Add-on 10 Minuten, statt neu anzumelden.
- Cloud-Codes 11910000/11911000/11912000 werden erklärt (Zone 1/2/Grandzone hat schon ein Programm oder kocht).

## 0.2.1
- Kurze Netzwerkfehler (z. B. DNS "Name or service not known") bauen die VeSync-Sitzung nicht mehr neu auf; erst nach 3 Fehlversuchen in Folge wird der Status als offline gemeldet.

## 0.2.0
- Grandzone (beide Zonen zusammen, workChamber 3) mit eigenen Entitäten: Modus, Temperatur, Zeit, Senden, Beenden, Status, Restzeit.
- Status wird direkt aus der Cloud-Antwort gelesen (inkl. Grandzone); bei aktiver Grandzone zeigen Zone 1/2 "Grandzone".
- Temperaturbereich 35-240 °C und Zeit bis 720 min: Die Cloud entscheidet, was für den Modus gültig ist (Dry/Grill lehnten 180 °C ab).
- Abgelehnte Befehle melden Modus, Temperatur, Zeit und Cloud-Code; die Verbindung wird dabei nicht mehr neu aufgebaut (behebt "Session is closed").
- "Letzte Meldung" zeigt nach einem Verbindungsfehler wieder "Verbunden".

## 0.1.0
- Erste Version: MQTT-Discovery für Cosori Dual Blaze (CAF-TF101S), je Zone Modus/Temperatur/Zeit, Senden/Beenden, Status und Restzeit.
