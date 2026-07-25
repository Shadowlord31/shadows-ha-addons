const express = require("express"), path = require("path");
require("./db/garten"); // Initialisiert die SQLite-Datenbank beim Start (legt Schema an, falls neu)

const app = express(), PORT = process.env.PORT || 3002;
app.use(express.json());
// API-Antworten enthalten staendig wechselnde Daten (Eintraege, Fruchtfolge-Verlauf etc.) -
// ohne diesen Header koennen Mobile-WebViews (z.B. HA-Companion-App) GET-Antworten im
// HTTP-Cache behalten und zeigen dann veraltete Daten an, die auch App-/Add-on-Neustarts
// ueberleben, weil es reines Client-Caching ist, kein Server-Zustand.
app.use("/garten/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/garten/api", require("./routes/garten"));
app.use("/garten/api/admin", require("./routes/migrate"));

app.get("/", (q, r) => r.sendFile(path.join(__dirname, "public/garten/index.html")));
app.get("/garten*", (q, r) => r.sendFile(path.join(__dirname, "public/garten/index.html")));
app.listen(PORT, () => console.log("Garden Journal listening on :" + PORT));
