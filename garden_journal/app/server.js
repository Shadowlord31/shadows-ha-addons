const express = require("express"), path = require("path");
require("./db/garten"); // Initialisiert die SQLite-Datenbank beim Start (legt Schema an, falls neu)

const app = express(), PORT = process.env.PORT || 3002;
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/garten/api", require("./routes/garten"));
app.use("/garten/api/admin", require("./routes/migrate"));

app.get("/", (q, r) => r.sendFile(path.join(__dirname, "public/garten/index.html")));
app.get("/garten*", (q, r) => r.sendFile(path.join(__dirname, "public/garten/index.html")));
app.listen(PORT, () => console.log("Garden Journal listening on :" + PORT));
