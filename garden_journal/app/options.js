const fs = require('fs');

// Der Supervisor schreibt die Add-on-Optionen nach /data/options.json.
// OPTIONS_PATH erlaubt lokale Tests ohne Supervisor.
const OPTIONS_PATH = process.env.OPTIONS_PATH || '/data/options.json';

function loadOptions() {
  try {
    return JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

module.exports = { loadOptions };
