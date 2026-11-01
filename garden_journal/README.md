# Garden Journal Add-on

Self-hosted garden journal for Home Assistant. Track beds, plantings, harvests,
perennials, planning, and costs directly from Ingress - no external database
or MQTT broker required.

**Status: work in progress**, not yet functional as an add-on. See the parent
repo's issues for progress.

## Companion Lovelace cards

[gartentagebuch-cards](https://github.com/Shadowlord31/gartentagebuch-cards)
(sprechen das Add-on ueber die Ingress-URL an, davon bleibt alles unveraendert)

## Konfiguration

| Option | Beschreibung |
|---|---|
| `api_token` | Selbst gewaehltes Token fuer externe Integrationen (z.B. einen Assistenten) ueber den optionalen Netzwerk-Port. Leer lassen, wenn nicht genutzt. |

## Optionaler Netzwerk-Port (fuer externe Integrationen)

Standardmaessig laeuft das Add-on **nur ueber Ingress** (kein Port exponiert). Im Tab
*Konfiguration > Netzwerk* kann der Port `3002` gesetzt werden, z.B. fuer einen Assistenten im LAN
oder hinter einem Reverse Proxy mit HTTPS.

- Zugriff ueber Ingress (Weboberflaeche, Lovelace-Karten, alle `/garten/api`-Routen): wie bisher offen.
- Direkter Zugriff ueber den Port: **nur** `/garten/api/integration/*` mit Header `X-API-Token`.
  Ist kein `api_token` gesetzt: 403. Fehlendes oder falsches Token: 401. Alle anderen Routen und die
  Oberflaeche antworten ueber den Port mit 401.
- Erkannt wird Ingress an der Quelladresse des Supervisor-Gateways (172.30.32.2), nicht an
  frei setzbaren Headern. Ein Reverse Proxy kommt daher immer als "direkt" an und braucht das Token.
- Empfehlung: Port nur aktivieren, wenn er gebraucht wird, `api_token` lang und zufaellig waehlen und
  extern nur per HTTPS freigeben.

## Integrations-API (`/garten/api/integration/*`, Header `X-API-Token`)

Antworten verwenden Namen statt IDs (Beete als Pfad, z.B. `Garten › Beet 1`); IDs gibt es nur bei
Eintraegen, Plaenen. Fehler: `{"error": "..."}` mit 400, 404 oder 409. `year` ist optional
(Standard: aktuelles Jahr, bei `entries` kein Jahresfilter).

| Methode & Pfad | Beschreibung |
|---|---|
| `GET overview?year=` | Beete mit aktuellem Bewuchs, offene Plaene des Jahres, Anzahl Eintraege |
| `GET beds` | Alle Beete |
| `GET plants` | Pflanzenkatalog mit Familie |
| `GET plant-families` | Pflanzenfamilien mit Anbaupause |
| `GET entries?year=&bed=&plant=&cat=&limit=` | Eintraege; `bed`/`plant` als Name (Teiltreffer), `cat` = `plant`/`harvest`, `limit` Standard 50 (max. 500) |
| `GET harvest?year=` | Ernte je Pflanze und Einheit |
| `GET costs?year=` | Summe je Kategorie und die letzten Eintraege |
| `GET plans?year=&open=1` | Geplante Aufgaben; `open=1` nur offene (ohne Dauerbepflanzungen) |
| `GET crop-rotation?bed=&plant=&year=` | Fruchtfolge-Status `ok`/`warning`/`blocked` mit Meldung |
| `POST entry` | Eintrag anlegen: `cat` (`plant`/`harvest`), `plant`, `bed`?, `date`?, `description`?, `harvest_amount`?, `harvest_unit`? (`kg`/`g`/`Stück`), `harvest_final`? |
| `POST cost` | Kosten anlegen: `date`?, `category`, `description`, `amount` |
| `PATCH plan/:id` | Nur `done` und `note` aendern |

Namensaufloesung bei `POST entry`: Pflanze exakt, sonst eindeutiger Teiltreffer (mehrere Treffer:
409 mit Vorschlaegen). Eine unbekannte Pflanze wird als Freitext eingetragen (`catalog_match: false`).
Unbekanntes Beet: 404 mit Liste der Beete. Es gibt bewusst keine Loesch-Routen.
