#!/usr/bin/env python3
"""Cosori Dual Blaze (CAF-TF101S) -> MQTT-Discovery Bridge fuer Home Assistant.

Drei Bereiche: Zone 1, Zone 2 und Grandzone (beide Zonen zusammen). Je Bereich:
Modus, Temperatur, Zeit (Eingaben), Senden/Beenden (Tasten), Status/Restzeit/
gesetzte Werte (Sensoren). Gestartet wird immer am Geraet
(readyStart=True = Programm vorbereiten, Start per Taste am Geraet).
"""
import asyncio
import json
import logging
import os
from dataclasses import replace
from pathlib import Path

import aiohttp
import aiomqtt
from pyvesync import VeSync
from pyvesync.const import TemperatureUnits
from pyvesync.models import fryer_models as models
from pyvesync.utils.device_mixins import process_bypassv2_result
from pyvesync.utils.errors import VeSyncRateLimitError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cosori")

OPT = json.loads(Path("/data/options.json").read_text()) if Path("/data/options.json").exists() else {}
EMAIL = OPT.get("vesync_email") or os.environ.get("VESYNC_EMAIL", "")
PASSWORD = OPT.get("vesync_password") or os.environ.get("VESYNC_PASSWORD", "")
COUNTRY = OPT.get("country_code") or "DE"
POLL = int(OPT.get("poll_interval") or 60)   # Ruhe-Intervall
POLL_ACTIVE = 20                              # waehrend ein Programm gesetzt ist/laeuft
RATE_LIMIT_PAUSE = 600
STATE_FILE = Path(os.environ.get("STATE_FILE", "/data/state.json"))

BASE = "cosori_fryer"
AVAIL = f"{BASE}/availability"
MODES = ["AirFry", "Bake", "Roast", "Grill", "Dry", "Reheat"]
# Bewusst weit: die Cloud entscheidet, was fuer den Modus gueltig ist.
TEMP_MIN, TEMP_MAX, TEMP_STEP = 35, 240, 5
MIN_MIN, MIN_MAX = 1, 720
ZONES = {"1": "Zone 1", "2": "Zone 2", "3": "Grandzone"}
STATUS_DE = {
    "standby": "Standby", "ready": "Bereit", "cookStop": "Bereit", "cooking": "Kocht",
    "pullOut": "Korb draussen", "completed": "Fertig", "cookEnd": "Fertig",
    "heating": "Heizt", "unknown": "Unbekannt",
}
DEFAULT_ZONE = {"mode": "AirFry", "temp": 180, "minutes": 15}

DEVICE = {
    "identifiers": ["cosori_fryer_caf_tf101s"],
    "name": "Cosori Dual Blaze",
    "manufacturer": "Cosori",
    "model": "CAF-TF101S",
}


def is_transient(e: Exception) -> bool:
    """Kurzzeitige Netzwerkfehler (DNS, Timeout): Sitzung behalten, nicht neu anmelden."""
    return isinstance(e, (aiohttp.ClientConnectionError, asyncio.TimeoutError, OSError))


CLOUD_CODES = {
    11910000: "Zone 1 hat schon ein Programm bzw. kocht - erst beenden",
    11911000: "Zone 2 hat schon ein Programm bzw. kocht - erst beenden",
    11912000: "Grandzone/alle Zonen haben schon ein Programm bzw. kochen - erst beenden",
}


class CloudRejected(RuntimeError):
    """Die VeSync-Cloud hat den Befehl abgelehnt (Verbindung/Login sind in Ordnung)."""


def load_state() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text())
    except Exception:
        data = {}
    return {z: {**DEFAULT_ZONE, **data.get(z, {})} for z in ZONES}


def save_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state))
    except Exception as e:  # noqa: BLE001
        log.warning("State nicht speicherbar: %s", e)


def idle() -> dict:
    return {"status": "Standby", "status_raw": "standby", "remaining_min": None,
            "set_temp": None, "set_minutes": None, "mode": None}


class Fryer:
    """Kapselt VeSync-Login und Befehle; baut die Verbindung bei Fehlern neu auf."""

    def __init__(self) -> None:
        self.mgr: VeSync | None = None
        self.dev = None
        self.lock = asyncio.Lock()

    async def close(self) -> None:
        async with self.lock:
            if self.mgr is not None:
                try:
                    await self.mgr.__aexit__(None, None, None)
                except Exception:  # noqa: BLE001
                    pass
            self.mgr = None
            self.dev = None

    async def ensure(self) -> None:
        if self.dev is not None:
            return
        mgr = VeSync(EMAIL, PASSWORD, country_code=COUNTRY)
        await mgr.__aenter__()
        try:
            if not await mgr.login():
                raise RuntimeError("VeSync-Login fehlgeschlagen")
            await mgr.update()
            dev = next((d for d in mgr.devices if "TF101S" in str(d.device_type)), None)
            if dev is None:
                raise RuntimeError("Keine CAF-TF101S im VeSync-Konto gefunden")
        except Exception:
            await mgr.__aexit__(None, None, None)
            raise
        self.mgr, self.dev = mgr, dev
        log.info("Verbunden mit %s (%s)", dev.device_name, dev.device_type)

    async def _status(self):
        resp = await self.dev.call_bypassv2_api(
            payload_method="getAirfryerMultiStatus",
            payload_update={"subDeviceNo": 0, "subDeviceType": ""},
        )
        model = process_bypassv2_result(self.dev, log, "get_details", resp,
                                        models.FryerDualMultiStatusResult)
        if model is None:
            raise RuntimeError(f"Status nicht lesbar: {resp}")
        self.dev.temp_unit = TemperatureUnits.from_string(model.tempUnit)
        return model

    async def refresh(self) -> dict:
        async with self.lock:
            await self.ensure()
            model = await self._status()
            items = {it.chamber: it for it in model.statusList}
            out = {z: idle() for z in ZONES}
            for ch, it in items.items():
                if str(ch) not in out:
                    continue
                raw = it.cookStatus
                if raw == "standby":
                    continue
                out[str(ch)] = {
                    "status": STATUS_DE.get(raw, raw),
                    "status_raw": raw,
                    "remaining_min": round(it.currentRemainingTime / 60, 1),
                    "set_temp": it.cookTemp,
                    "set_minutes": round(it.cookSetTime / 60, 1),
                    "mode": it.mode,
                }
            if 3 in items and items[3].cookStatus != "standby":
                for z in ("1", "2"):
                    out[z]["status"] = "Grandzone"
            return out

    async def send_zone(self, zone: int, cfg: dict) -> str:
        async with self.lock:
            await self.ensure()
            d = self.dev
            await self._status()
            unit = d.temp_unit.code
            temp_c = int(round(cfg["temp"] / TEMP_STEP) * TEMP_STEP)
            temp_c = max(TEMP_MIN, min(TEMP_MAX, temp_c))
            temp = temp_c if unit == "c" else round(temp_c * 9 / 5 + 32)
            d.sync_chambers = False
            recipe = replace(d.default_preset, cook_time=int(cfg["minutes"]) * 60,
                             target_temp=temp, cook_mode=cfg["mode"])
            cfgs = d._build_cook_configs(recipe, zone)
            data = models.FryerDualStartCookData.from_dict({
                "accountId": self.mgr.account_id,
                "cookConfigs": [c.to_dict() for c in cfgs],
                "readyStart": True, "syncType": 0, "tempUnit": unit, "workChamber": zone,
            })
            resp = await d.call_bypassv2_api(payload_method="startMultiCook", data=data.to_dict())
            label = f"{ZONES[str(zone)]}: {cfg['mode']} {temp_c} C {cfg['minutes']} min"
            outer = (resp or {}).get("code")
            inner = ((resp or {}).get("result") or {}).get("code", 0)
            if outer != 0 or inner != 0:
                code = inner or outer
                hint = CLOUD_CODES.get(code, "Temperatur/Zeit passen evtl. nicht zum Modus")
                raise CloudRejected(f"{label} abgelehnt (Cloud-Code {code}): {hint}")
            return f"{label} gesendet"

    async def end_zone(self, zone: int) -> str:
        async with self.lock:
            await self.ensure()
            self.dev.sync_chambers = False
            ok = await self.dev.end(chamber=zone)
            if not ok:
                raise CloudRejected(f"{ZONES[str(zone)]}: Beenden nicht bestaetigt")
            return f"{ZONES[str(zone)]}: beendet"


def disc(component: str, obj: str, cfg: dict) -> tuple[str, str]:
    cfg = {
        "unique_id": f"cosori_fryer_{obj}",
        "object_id": f"cosori_{obj}",
        "device": DEVICE,
        "availability_topic": AVAIL,
        **cfg,
    }
    return f"homeassistant/{component}/cosori_fryer/{obj}/config", json.dumps(cfg)


def discovery_messages() -> list[tuple[str, str]]:
    msgs = []
    for z, label in ZONES.items():
        t = f"{BASE}/z{z}"
        msgs.append(disc("select", f"z{z}_modus", {
            "name": f"{label} Modus", "options": MODES,
            "command_topic": f"{t}/mode/set", "state_topic": f"{t}/mode/state", "icon": "mdi:chef-hat"}))
        msgs.append(disc("number", f"z{z}_temperatur", {
            "name": f"{label} Temperatur", "min": TEMP_MIN, "max": TEMP_MAX, "step": TEMP_STEP,
            "mode": "box", "unit_of_measurement": "°C", "device_class": "temperature",
            "command_topic": f"{t}/temp/set", "state_topic": f"{t}/temp/state"}))
        msgs.append(disc("number", f"z{z}_zeit", {
            "name": f"{label} Zeit", "min": MIN_MIN, "max": MIN_MAX, "step": 1,
            "mode": "box", "unit_of_measurement": "min", "icon": "mdi:timer-outline",
            "command_topic": f"{t}/minutes/set", "state_topic": f"{t}/minutes/state"}))
        msgs.append(disc("button", f"z{z}_senden", {
            "name": f"{label} Programm senden", "command_topic": f"{t}/send/press",
            "payload_press": "PRESS", "icon": "mdi:send"}))
        msgs.append(disc("button", f"z{z}_beenden", {
            "name": f"{label} Beenden", "command_topic": f"{t}/end/press",
            "payload_press": "PRESS", "icon": "mdi:stop"}))
        st = f"{t}/state"
        msgs.append(disc("sensor", f"z{z}_status", {
            "name": f"{label} Status", "state_topic": st,
            "value_template": "{{ value_json.status }}", "icon": "mdi:air-fryer"}))
        msgs.append(disc("sensor", f"z{z}_restzeit", {
            "name": f"{label} Restzeit", "state_topic": st,
            "value_template": "{{ value_json.remaining_min | default(none) }}",
            "unit_of_measurement": "min", "icon": "mdi:timer-sand"}))
        msgs.append(disc("sensor", f"z{z}_gesetzte_temperatur", {
            "name": f"{label} Gesetzte Temperatur", "state_topic": st,
            "value_template": "{{ value_json.set_temp | default(none) }}",
            "unit_of_measurement": "°C", "device_class": "temperature"}))
        msgs.append(disc("sensor", f"z{z}_gesetzte_zeit", {
            "name": f"{label} Gesetzte Zeit", "state_topic": st,
            "value_template": "{{ value_json.set_minutes | default(none) }}",
            "unit_of_measurement": "min"}))
    msgs.append(disc("button", "beide_senden", {
        "name": "Beide Zonen senden", "command_topic": f"{BASE}/both/send/press",
        "payload_press": "PRESS", "icon": "mdi:send-circle"}))
    msgs.append(disc("button", "beide_beenden", {
        "name": "Beide Zonen beenden", "command_topic": f"{BASE}/both/end/press",
        "payload_press": "PRESS", "icon": "mdi:stop-circle"}))
    msgs.append(disc("sensor", "letzte_meldung", {
        "name": "Letzte Meldung", "state_topic": f"{BASE}/message",
        "icon": "mdi:message-text-outline", "entity_category": "diagnostic"}))
    return msgs


async def mqtt_credentials() -> dict:
    if OPT.get("mqtt_host"):
        return {"host": OPT["mqtt_host"], "port": int(OPT.get("mqtt_port") or 1883),
                "username": OPT.get("mqtt_user") or None, "password": OPT.get("mqtt_password") or None}
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        raise RuntimeError("Kein SUPERVISOR_TOKEN und kein mqtt_host in den Optionen")
    async with aiohttp.ClientSession() as s:
        async with s.get("http://supervisor/services/mqtt",
                         headers={"Authorization": f"Bearer {token}"}) as r:
            r.raise_for_status()
            d = (await r.json())["data"]
    return {"host": d["host"], "port": int(d["port"]),
            "username": d.get("username"), "password": d.get("password")}


class App:
    def __init__(self) -> None:
        self.fryer = Fryer()
        self.state = load_state()
        self.client: aiomqtt.Client | None = None
        self.had_error = False
        self.fail_count = 0
        self.active = False
        self.pause_until = 0.0

    async def pub(self, topic: str, payload, retain: bool = True) -> None:
        await self.client.publish(topic, payload if isinstance(payload, (str, bytes)) else json.dumps(payload),
                                  retain=retain)

    async def say(self, text: str) -> None:
        log.info(text)
        await self.pub(f"{BASE}/message", text[:250])

    async def publish_inputs(self) -> None:
        for z in ZONES:
            c = self.state[z]
            await self.pub(f"{BASE}/z{z}/mode/state", c["mode"])
            await self.pub(f"{BASE}/z{z}/temp/state", str(c["temp"]))
            await self.pub(f"{BASE}/z{z}/minutes/state", str(c["minutes"]))

    async def poll_once(self) -> None:
        try:
            data = await self.fryer.refresh()
        except VeSyncRateLimitError:
            self.pause_until = asyncio.get_event_loop().time() + RATE_LIMIT_PAUSE
            self.had_error = True
            await self.say(f"VeSync meldet Rate-Limit - Pause {RATE_LIMIT_PAUSE // 60} min")
            await self.pub(AVAIL, "offline")
            return
        except Exception as e:  # noqa: BLE001
            self.fail_count += 1
            transient = is_transient(e)
            if not transient:
                await self.fryer.close()
            if transient and self.fail_count < 3:
                # Kurzer Netzwerkaussetzer: still weiterversuchen, Sitzung bleibt bestehen
                log.warning("Status voruebergehend nicht abrufbar (%s), Versuch %d", e, self.fail_count)
                return
            self.had_error = True
            await self.say(f"VeSync-Fehler beim Status: {e}")
            await self.pub(AVAIL, "offline")
            return
        self.fail_count = 0
        self.active = any(v.get("status_raw") != "standby" for v in data.values())
        await self.pub(AVAIL, "online")
        if self.had_error:
            self.had_error = False
            await self.say("Verbunden, Status wird wieder abgefragt")
        for z, v in data.items():
            await self.pub(f"{BASE}/z{z}/state", v)

    async def poll_loop(self) -> None:
        while True:
            wait = self.pause_until - asyncio.get_event_loop().time()
            if wait > 0:
                await asyncio.sleep(wait)
            await self.poll_once()
            await asyncio.sleep(min(POLL, POLL_ACTIVE) if self.active else POLL)

    async def run_action(self, label: str, coros) -> None:
        msgs = []
        try:
            for i, make in enumerate(coros):
                if i:
                    await asyncio.sleep(2)
                msgs.append(await make())
            await self.say("OK - " + " | ".join(msgs))
        except CloudRejected as e:
            # Verbindung ist in Ordnung, nur der Befehl wurde abgelehnt
            await self.say(f"Fehler: {e}")
        except Exception as e:  # noqa: BLE001
            if not is_transient(e):
                await self.fryer.close()
            await self.say(f"Fehler ({label}): {e}")
        await asyncio.sleep(2)
        await self.poll_once()

    async def handle(self, topic: str, payload: str) -> None:
        parts = topic.split("/")
        if len(parts) == 4 and parts[1].startswith("z") and parts[3] == "set":
            z, field = parts[1][1:], parts[2]
            if z not in self.state:
                return
            try:
                if field == "mode":
                    if payload not in MODES:
                        raise ValueError(f"Unbekannter Modus {payload}")
                    self.state[z]["mode"] = payload
                elif field == "temp":
                    v = int(round(float(payload) / TEMP_STEP) * TEMP_STEP)
                    self.state[z]["temp"] = max(TEMP_MIN, min(TEMP_MAX, v))
                elif field == "minutes":
                    v = int(round(float(payload)))
                    self.state[z]["minutes"] = max(MIN_MIN, min(MIN_MAX, v))
                else:
                    return
            except ValueError as e:
                await self.say(f"Ungueltiger Wert ({topic}): {e}")
                return
            save_state(self.state)
            await self.publish_inputs()
        elif len(parts) == 4 and parts[1].startswith("z") and parts[1][1:] in ZONES and parts[2] == "send":
            z = int(parts[1][1:])
            await self.run_action(f"{ZONES[str(z)]} senden", [lambda: self.fryer.send_zone(z, self.state[str(z)])])
        elif len(parts) == 4 and parts[1].startswith("z") and parts[1][1:] in ZONES and parts[2] == "end":
            z = int(parts[1][1:])
            await self.run_action(f"{ZONES[str(z)]} beenden", [lambda: self.fryer.end_zone(z)])
        elif topic == f"{BASE}/both/send/press":
            await self.run_action("beide senden", [
                lambda: self.fryer.send_zone(1, self.state["1"]),
                lambda: self.fryer.send_zone(2, self.state["2"])])
        elif topic == f"{BASE}/both/end/press":
            await self.run_action("beide beenden", [
                lambda: self.fryer.end_zone(1), lambda: self.fryer.end_zone(2)])

    async def run(self) -> None:
        cred = await mqtt_credentials()
        async with aiomqtt.Client(
            hostname=cred["host"], port=cred["port"], username=cred["username"], password=cred["password"],
            will=aiomqtt.Will(AVAIL, "offline", retain=True),
        ) as client:
            self.client = client
            log.info("MQTT verbunden (%s:%s)", cred["host"], cred["port"])
            for topic, payload in discovery_messages():
                await self.pub(topic, payload)
            await self.publish_inputs()
            await client.subscribe(f"{BASE}/#")
            poll = asyncio.create_task(self.poll_loop())
            tasks: set[asyncio.Task] = set()
            try:
                async for msg in client.messages:
                    t = str(msg.topic)
                    if not (t.endswith("/set") or t.endswith("/press")):
                        continue
                    payload = msg.payload.decode() if isinstance(msg.payload, (bytes, bytearray)) else str(msg.payload)
                    task = asyncio.create_task(self.handle(t, payload))
                    tasks.add(task)
                    task.add_done_callback(tasks.discard)
            finally:
                poll.cancel()


async def main() -> None:
    if not EMAIL or not PASSWORD:
        raise SystemExit("vesync_email / vesync_password in den Add-on-Optionen setzen")
    app = App()
    while True:
        try:
            await app.run()
        except Exception as e:  # noqa: BLE001
            log.error("Fehler: %s - neuer Versuch in 15 s", e)
            await asyncio.sleep(15)


if __name__ == "__main__":
    asyncio.run(main())
