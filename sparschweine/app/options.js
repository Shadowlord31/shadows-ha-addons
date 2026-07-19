const fs = require('fs');

// Home Assistant Supervisor schreibt die im Addon konfigurierten Optionen
// immer nach /data/options.json, unabhaengig von init:true/false.
function loadOptions() {
  try {
    return JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  } catch {
    return {};
  }
}

module.exports = { loadOptions };
