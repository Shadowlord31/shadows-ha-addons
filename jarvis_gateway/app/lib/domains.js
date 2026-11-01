// Feste Zuordnung Aktion -> Home-Assistant-Service mit Parameter-Positivliste.
// Nichts, was nicht hier steht, wird jemals an Home Assistant weitergereicht.

const ROLES = ['admin', 'erwachsen', 'kind', 'unbekannt'];
const ROLE_RANK = { unbekannt: 0, kind: 1, erwachsen: 2, admin: 3 };
const MIN_ROLES = ['all', 'erwachsen', 'admin'];
const MIN_ROLE_RANK = { all: 0, erwachsen: 2, admin: 3 };
const MIN_ROLE_LABEL = { all: 'alle', erwachsen: 'erwachsen', admin: 'admin' };

const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

// Parameter-Typen:
//  int/number: Wertebereich min..max (absolut), pro Entitaet einschraenkbar (limits)
//  bool, rgb
//  choice: Wert muss in einer Liste stehen (values = fest, attr = aus Entitaets-Attribut), pro Entitaet einschraenkbar (limits.allowed)
const int = (min, max, extra = {}) => ({ type: 'int', min, max, ...extra });
const num = (min, max, extra = {}) => ({ type: 'number', min, max, ...extra });

const onOff = (d) => ({
  turn_on: { service: `${d}.turn_on`, label: 'Einschalten', params: {} },
  turn_off: { service: `${d}.turn_off`, label: 'Ausschalten', params: {} },
  toggle: { service: `${d}.toggle`, label: 'Umschalten', params: {} },
});

const ACTIONS = {
  light: {
    turn_on: {
      service: 'light.turn_on', label: 'Einschalten',
      params: {
        brightness_pct: int(0, 100, { label: 'Helligkeit %', ha: 'brightness_pct', unit: '%' }),
        color_temp_kelvin: int(1000, 10000, { label: 'Farbtemperatur K', ha: 'color_temp_kelvin', unit: 'K', defMin: 2000, defMax: 6500 }),
        rgb_color: { type: 'rgb', label: 'Farbe (RGB)', ha: 'rgb_color' },
      },
      exclusive: [['color_temp_kelvin', 'rgb_color']],
    },
    turn_off: { service: 'light.turn_off', label: 'Ausschalten', params: {} },
    toggle: { service: 'light.toggle', label: 'Umschalten', params: {} },
  },
  switch: onOff('switch'),
  input_boolean: onOff('input_boolean'),
  climate: {
    set_temperature: {
      service: 'climate.set_temperature', label: 'Temperatur setzen',
      params: { temperature: num(0, 100, { label: 'Temperatur °C', ha: 'temperature', unit: '°C', required: true, defMin: 5, defMax: 30, attrMin: 'min_temp', attrMax: 'max_temp' }) },
    },
    set_hvac_mode: {
      service: 'climate.set_hvac_mode', label: 'Betriebsart setzen',
      params: { hvac_mode: { type: 'choice', values: ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'], label: 'Betriebsart', ha: 'hvac_mode', required: true, attr: 'hvac_modes' } },
    },
    set_preset_mode: {
      service: 'climate.set_preset_mode', label: 'Preset setzen',
      params: { preset_mode: { type: 'choice', attr: 'preset_modes', label: 'Preset', ha: 'preset_mode', required: true } },
    },
  },
  cover: {
    open: { service: 'cover.open_cover', label: 'Öffnen', params: {} },
    close: { service: 'cover.close_cover', label: 'Schließen', params: {} },
    stop: { service: 'cover.stop_cover', label: 'Stoppen', params: {} },
    set_cover_position: {
      service: 'cover.set_cover_position', label: 'Position setzen',
      params: { position: int(0, 100, { label: 'Position %', ha: 'position', unit: '%', required: true }) },
    },
  },
  media_player: {
    play: { service: 'media_player.media_play', label: 'Wiedergabe', params: {} },
    pause: { service: 'media_player.media_pause', label: 'Pause', params: {} },
    next: { service: 'media_player.media_next_track', label: 'Nächster Titel', params: {} },
    previous: { service: 'media_player.media_previous_track', label: 'Vorheriger Titel', params: {} },
    volume_set: {
      service: 'media_player.volume_set', label: 'Lautstärke setzen',
      params: { volume_pct: int(0, 100, { label: 'Lautstärke %', ha: 'volume_level', unit: '%', required: true, toHa: (v) => v / 100 }) },
    },
    volume_mute: {
      service: 'media_player.volume_mute', label: 'Stummschalten',
      params: { mute: { type: 'bool', label: 'Stumm', ha: 'is_volume_muted', required: true } },
    },
  },
  fan: {
    turn_on: { service: 'fan.turn_on', label: 'Einschalten', params: {} },
    turn_off: { service: 'fan.turn_off', label: 'Ausschalten', params: {} },
    set_percentage: {
      service: 'fan.set_percentage', label: 'Geschwindigkeit setzen',
      params: { percentage: int(0, 100, { label: 'Geschwindigkeit %', ha: 'percentage', unit: '%', required: true }) },
    },
  },
  lock: {
    lock: { service: 'lock.lock', label: 'Abschließen', params: {} },
    unlock: { service: 'lock.unlock', label: 'Aufschließen', params: {}, defaultMinRole: 'erwachsen' },
  },
  vacuum: {
    start: { service: 'vacuum.start', label: 'Starten', params: {} },
    pause: { service: 'vacuum.pause', label: 'Pause', params: {} },
    return_to_base: { service: 'vacuum.return_to_base', label: 'Zur Station', params: {} },
  },
  script: { turn_on: { service: 'script.turn_on', label: 'Ausführen', params: {} } },
  scene: { turn_on: { service: 'scene.turn_on', label: 'Aktivieren', params: {} } },
  button: { press: { service: 'button.press', label: 'Drücken', params: {} } },
  automation: { trigger: { service: 'automation.trigger', label: 'Auslösen', params: {} } },
  input_number: {
    set_value: {
      service: 'input_number.set_value', label: 'Wert setzen',
      params: { value: num(-1e9, 1e9, { label: 'Wert', ha: 'value', required: true, defMin: 0, defMax: 100, attrMin: 'min', attrMax: 'max' }) },
    },
  },
  input_select: {
    select_option: {
      service: 'input_select.select_option', label: 'Option wählen',
      params: { option: { type: 'choice', attr: 'options', label: 'Option', ha: 'option', required: true } },
    },
  },
};

// Lesbare Attribute: feste Positivliste je Domain. Alles andere wird nie ausgegeben.
// person/device_tracker: nur der Zustand, keine GPS-Daten.
const ATTRIBUTES = {
  light: ['brightness', 'color_temp', 'color_temp_kelvin', 'rgb_color', 'min_color_temp_kelvin', 'max_color_temp_kelvin'],
  climate: ['current_temperature', 'temperature', 'hvac_action', 'hvac_modes', 'preset_mode', 'preset_modes', 'min_temp', 'max_temp', 'current_humidity'],
  cover: ['current_position'],
  media_player: ['volume_level', 'media_title', 'media_artist', 'is_volume_muted'],
  sensor: ['unit_of_measurement', 'device_class'],
  binary_sensor: ['device_class'],
  weather: ['temperature', 'humidity', 'pressure', 'wind_speed', 'temperature_unit'],
  fan: ['percentage', 'preset_mode'],
  vacuum: ['battery_level', 'status'],
  input_number: ['min', 'max', 'step', 'unit_of_measurement'],
  input_select: ['options'],
  person: [],
  device_tracker: [],
};

const READ_ONLY_DEFAULT_DOMAINS = new Set(['sensor', 'binary_sensor', 'weather']);

function actionsFor(domain) {
  return Object.hasOwn(ACTIONS, domain) ? ACTIONS[domain] : {};
}
function attributesFor(domain) {
  return Object.hasOwn(ATTRIBUTES, domain) ? ATTRIBUTES[domain] : [];
}
function isControllable(domain) {
  return Object.keys(actionsFor(domain)).length > 0;
}
function domainOf(entityId) {
  return String(entityId).split('.')[0];
}

// Metadaten fuer die Oberflaeche (ohne Funktionen)
function templates() {
  const out = {};
  for (const [domain, acts] of Object.entries(ACTIONS)) {
    out[domain] = {};
    for (const [name, a] of Object.entries(acts)) {
      const params = {};
      for (const [pn, p] of Object.entries(a.params)) {
        const { toHa, ha, ...pub } = p;
        params[pn] = pub;
      }
      out[domain][name] = { label: a.label, params, defaultMinRole: a.defaultMinRole || 'all' };
    }
  }
  return { actions: out, attributes: ATTRIBUTES };
}

module.exports = {
  ROLES, ROLE_RANK, MIN_ROLES, MIN_ROLE_RANK, MIN_ROLE_LABEL, ENTITY_ID_RE,
  ACTIONS, ATTRIBUTES, READ_ONLY_DEFAULT_DOMAINS,
  actionsFor, attributesFor, isControllable, domainOf, templates,
};
