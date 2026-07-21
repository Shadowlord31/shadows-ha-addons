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
