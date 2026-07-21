## 0.6.2
- Fix: Docker-Build schlug auf dem Test-HA-Host fehl, da der Download der vorgebauten better-sqlite3-Binary (prebuild-install) getimeoutet ist und der Kompilier-Fallback (node-gyp) mangels Python im bookworm-slim-Image nicht greifen konnte. Dockerfile installiert jetzt python3/make/g++, damit der Fallback in jedem Fall funktioniert.

## 0.6.1
- Fix: 0.6.0 hatte einen kaputten Build - eine fehlerhafte Textersetzung beim Einbauen von Import/Export hat mehrere Funktionen (Sparschwein bearbeiten, Buchungen loeschen, Kategorien loeschen) unbenutzbar gemacht. Sauber aus der letzten guten Version neu aufgebaut und alle betroffenen Funktionen erneut getestet.
- Export-Download laeuft jetzt ueber eine echte Server-Navigation mit Content-Disposition-Header statt Blob+Klick, da Letzteres in Ingress-iframes (HA-App, mobile Browser) oft stillschweigend blockiert wird
- Neuer Fallback "In Zwischenablage kopieren" fuer den Fall, dass der Download trotzdem nicht ausloest

## 0.6.0
- Import- & Export-Funktion (Zahnrad-Symbol 💾): Export als JSON-Datei (Backup, Uebertragung auf andere Instanz), Import per Datei-Upload
- Import ist idempotent - bereits vorhandene Eintraege (per ID) werden uebersprungen, kein Ueberschreiben/Duplizieren
- Interner Umbau: routes/import.js -> routes/data.js (Import und Export im selben Modul)

## 0.5.0
- Statistik-Kategorien sind jetzt anklickbar: zeigt die Buchungen der Kategorie im aktuell gewaehlten Monat (inkl. zugehoerigem Sparschwein), als eigene Seite mit Loeschen-Option

## 0.4.0
- Karten-Redesign: eigenes warmes Farbschema, groessere Sparschwein-Icons, Hover-Effekte
- Responsives Grid: Sparschweine liegen auf breiten Displays nebeneinander statt gestapelt
- Detailansicht ist jetzt eine eigene Seite statt ein Pop-up
- Statistik-Seite mit Monatsauswahl (vor/zurueck), zeigt nur Buchungen des gewaehlten Monats

## 0.3.2
- Neue Route POST /api/bulk-import fuer einmalige Datenuebernahmen (nimmt Kategorien/Sparschweine/Buchungen im Request entgegen, ruft selbst nichts extern ab)

## 0.3.1
- FAB (+) öffnet jetzt das gemeinsame Buchen-Modal statt "Neues Sparschwein"
- "Neues Sparschwein" ist jetzt ein eigenes Icon in der Kopfzeile

## 0.3.0
- Buchungen jetzt mit ODER ohne Sparschwein möglich (z.B. Trinkgeld direkt tracken, ohne es einem Sparziel zuzuordnen)
- Neue Kachel "Ohne Sparschwein" in der Übersicht mit eigener Summe und Buchungsliste
- Löschen eines Sparschweins entfernt nicht mehr dessen Buchungen, sondern verschiebt sie zu "Ohne Sparschwein"

## 0.2.0
- Kategorien für Buchungen (anlegen/löschen, Farbe)
- Sparschweine sind jetzt anklickbar → Detailansicht mit Buchungsliste
- Statistik-Seite: Summen pro Kategorie
- Finanz-App-Import entfernt (keine hardcodierte URL/IP mehr, keine externe Abhängigkeit)

## 0.1.0
- Erste Version: Sparschweine mit Zielbetrag, Buchungen, Import aus der Finanz-App
