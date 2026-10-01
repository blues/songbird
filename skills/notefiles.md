---
kind: notefiles,derivation,sentinels,scenarios,population,config
description: Songbird Notefile inventory — application and system files, fields, sentinels, mode scenarios, population/config notes
updated: 2026-10-01T16:56:28Z
sources:
  - H1: trainer, interview 2026-09-30
  - F1: host firmware and public reference implementation for the demo asset, public, reviewed 2026-10-01
  - F2: `songbird-firmware/src/commands/SongbirdEnv.h`, `SongbirdEnv.cpp`, and `src/core/SongbirdConfig.h`, public, reviewed 2026-10-01
  - F3: `songbird-firmware/src/notecard/SongbirdNotecard.cpp`, `src/commands/SongbirdCommands.cpp`, `src/audio/SongbirdAudio.cpp`, and `src/core/SongbirdConfig.h`, public, reviewed 2026-10-01
  - D3: `sales-enablement/setup-guide.md`, `demo-script.md`, and `presentation-outline.md`, reviewed 2026-10-01
  - S1: project Notefile schemas observed 2026-10-01
  - D1: published product requirements for the sales-demo asset, restricted, reviewed 2026-10-01
  - P1: shared platform meaning for native Notecard/Notehub fields (see index pointer), public
---

# Songbird — data and Notefiles

**System Notefiles are first-class** here: connectivity, power, GPS track status, and triangulation live alongside app files. Shared platform definitions for native bodies live in the notehub-platform skill linked from `index.md`; this file adds **Songbird-specific** meaning, fields, and when silence is expected.

**Clocks:** unless stated, time-bounded questions use **event arrival / Notehub received time in UTC**. Measurement time for GPS points prefers capture time on `_track.qo` when present. Device clocks can be wrong before time sync — prefer server-received for “when did we hear from it.”

**Templated app files:** `track.qo`, `alert.qo`, and `command_ack.qo` use compact templates — omitted numeric/bool fields can appear as zeros/false on the wire; absence and a real zero are not always distinguishable without context. `[documented:host firmware templates, reviewed 2026-10-01 conf:high]`

---

## Roster (reconcile)

| Notefile | Direction | Writer | Role |
| --- | --- | --- | --- |
| `track.qo` | outbound | host | Environmental telemetry + mode + lock flags |
| `alert.qo` | outbound | host | Threshold / motion alerts (immediate sync) |
| `command.qi` | inbound | cloud / Notehub | Cloud-to-device commands |
| `command_ack.qo` | outbound | host | Command execution acknowledgment |
| `health.qo` | outbound | host | Host health / shutdown notes (partial schema observed) |
| `_track.qo` | outbound | Notecard | Autonomous GPS track + journey fields (transit) |
| `_geolocate.qo` | outbound | Notecard | Cell/Wi-Fi triangulation |
| `_session.qo` | service/device | Notecard/Notehub | Session open/close; connectivity narrative |
| `_health.qo` | outbound | Notecard | Voltage / power / diagnostic health |
| `_log.qo` | outbound | Notecard/Mojo path | Mojo power monitoring (mAh, voltage) |
| `_watchdog.qo` | service | Notehub | Fleet watchdog silence signals |
| `_health_host.qo` | — | — | Observed name; **no body schema yet** `[observed:schemas 2026-10-01 conf:medium]` |

Also observed: opaque short names without schemas (treat as unknown / non-product unless explained). `[observed:schemas 2026-10-01 conf:medium]`

Sources walked: firmware Notefile list, requirements Notefile table, live schemas. App + system names above are on the roster.

---

## Application Notefiles

### `track.qo` — telemetry heartbeat

- **Role:** Periodic environmental sample plus operating mode and lock flags — the usual “what is the box doing right now” stream.
- **Cadence:** Mode-dependent (demo: frequent / immediate sync; transit/storage: slower). Silence in demo for many minutes is abnormal; silence for an hour in storage can be normal. `[documented:mode table, reviewed 2026-10-01 conf:high]`
- **Templated:** yes.
- **Timestamps:** body `_time` when present = device measurement intent; use received time for fleet “last heard.”

| Field | Meaning | Type / units | Sentinels / validity | Rungs |
| --- | --- | --- | --- | --- |
| `temp` | BME280 temperature | number, °C | Treat extreme board-temp as environment of the demo, not a cold-chain contract; sensor fail → invalid reads (host `valid` flag not on wire) | `[rungs:1-3]` |
| `humidity` | Relative humidity | number, %RH 0–100 | Same sensor caveats | `[rungs:1-3]` |
| `pressure` | Barometric pressure | number, hPa | Pressure swings trigger `pressure_change` alerts when delta exceeds env threshold | `[rungs:1-3]` |
| `motion` | Motion since last read | bool | true = motion detected; false is normal at rest — **not** “sensor dead” | `[rungs:1-2]` |
| `mode` | Operating mode string | string: `demo` \| `transit` \| `storage` \| `sleep` | Unknown/empty → do not invent mode | `[rungs:1-4]` |
| `transit_locked` | Transit lock engaged | bool | true blocks remote mode changes | `[rungs:1-4]` |
| `demo_locked` | Demo lock engaged | bool | true blocks remote mode changes | `[rungs:1-4]` |
| `voltage` | *(legacy / not current track payload)* | — | **Battery voltage is not carried on current `track.qo`**; use `_log.qo` / `_health.qo`. Schema may still mention historical voltage. `[documented:firmware + ingest comments, reviewed 2026-10-01 conf:high]` | `[rungs:1]` |

**Aliases:** temperature on `_track.qo` may appear as `temperature` (full word) when Notecard attaches env samples to track notes — do not join blindly to `temp` without noting the name difference. `[observed:schemas 2026-10-01 conf:high]`

### `alert.qo` — host alerts

- **Role:** Discrete alert events when thresholds cross or motion alert fires; **always synced immediately**.
- **Cadence:** On transition into alert (host tracks flags so it does not spam forever); not a periodic file. **Silence means no new crossing**, not “healthy forever.”
- **Templated:** yes.

| Field | Meaning | Type / units | Notes | Rungs |
| --- | --- | --- | --- | --- |
| `type` | Alert kind | string ≤16 | See **Primary alert types** below | `[rungs:1-4]` |
| `value` | Measured value that tripped | number | Units depend on type (°C, %RH, hPa, V, …) | `[rungs:1-2]` |
| `threshold` | Threshold compared against | number | From env / defaults | `[rungs:1-3]` |
| `message` | Human text | string ≤64 | Display aid; do not parse as sole truth | `[rungs:1]` |

#### Primary alert types (product vocabulary → wire)

Trainer primary list: **temp, humidity, pressure_change, low_battery, motion, gps_no_sat**. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`

| Category (asker) | Wire `alert.qo` `type` (host) | Notes |
| --- | --- | --- |
| temp | `temp_high`, `temp_low` | Defaults ~35 °C high / 0 °C low (env overrides) |
| humidity | `humidity_high`, `humidity_low` | Defaults ~80% / 20% |
| pressure_change | `pressure_change` | Delta vs prior pressure; default ~10 hPa |
| low_battery | `low_battery` | Default ~3.4 V; also cloud may synthesize related battery alerts from health |
| motion | `motion` | Defined in firmware; confirm how often demos rely on it `[assumed conf:low]` — Q pending |
| gps_no_sat | **not a host `alert.qo` template enum** | Cloud/dashboard alert + device flag derived from **`_track.qo` status `no-sat`** | 

Dashboard/cloud may also emit `gps_power_save` when GPS power-save engages. `[documented:ingest behavior, reviewed 2026-10-01 conf:high]`

### `command.qi` — inbound commands

- **Role:** Cloud → device commands.
- **Writer / read path:** Notehub or the companion cloud writes the note; firmware calls `note.get` with `file=command.qi` and `delete=true`, so the note is consumed when read. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:579-607, reviewed 2026-10-01 conf:high]`
- **Common body shape (firmware + live events):** `{"command_id":"<id>","cmd":"<name>","params":{…},"sent_at":<ms>}`. Firmware reads `command_id` (optional but needed for useful ack correlation), `cmd`, and nested `params`; cloud may also send `sent_at` (not used by firmware). `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:608-672, reviewed 2026-10-01 conf:high]` `[observed:Notehub Events API files=command.qi, 2026-10-01 conf:high]`
- **Project schema:** `list_project_notefile_schemas` still returns `command.qi` with `properties: null` — do not treat an empty schema as “no body.” Prefer Events API / firmware for the request shape, and `command_ack.qo` for outcomes. `[observed:schemas + events 2026-10-01 conf:high]`
- **Live events observed (Events API window, 2026-10-01):** three retained `command.qi` notes — `unlock` with `params.lock_type=all` (songbird-06, correlated acks ok/ignored) and `play_melody` with `params.melody=connected` (songbird-01, ack ok). Older `ping` / `locate` traffic is visible on IQ `command_ack` but not in the current Events retention window. `[observed:Events API + IQ command_ack 2026-10-01 conf:high]`
- **API wrapper:** when writing the note through the Notes API, the same object is carried under the request `body` property; the firmware parses the received note body, not an additional `cmd` wrapper. `[documented:sales-enablement/demo-script.md:208-215; sales-enablement/presentation-outline.md:265-285, reviewed 2026-10-01 conf:high]`

#### `ping` (primary sales-demo command)

Body: `{"command_id":"<command id>","cmd":"ping"}`; no `params` are read. If audio is enabled and not in alerts-only mode, the device queues the `AUDIO_EVENT_PING` notification chime and acknowledges `ok` with message `Ping played`. If audio is disabled, it does not play audio and acknowledges `ignored` with `Audio disabled`; if `audio_alerts_only=true` suppresses the non-alert ping (or the queue is full), the handler returns `error` with `Failed to queue audio`. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:608-621; src/commands/SongbirdCommands.cpp:133-151; src/audio/SongbirdAudio.cpp:312-320, reviewed 2026-10-01 conf:high]`

#### Other firmware command names and fields

| `cmd` | Body fields | Firmware behavior / limits |
| --- | --- | --- |
| `locate` | `params.duration_sec` (optional integer, seconds) | Repeating find-me audio; omitted/zero uses `locate_duration_sec` default 30; clamps to 5–300 seconds. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:622-632; src/commands/SongbirdCommands.cpp:153-176]` |
| `play_melody` | `params.melody` (string) | Plays one of `connected`, `power_on`, `alert`, `ping`, `error`, `low_battery`, `gps_lock`, `sleep`; unknown names error. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:633-642; src/commands/SongbirdCommands.cpp:179-207]` |
| `test_audio` | `params.frequency` (Hz), `params.duration_ms` (milliseconds) | Test tone; frequency 100–10,000 Hz and duration 50–5,000 ms. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:643-649; src/commands/SongbirdCommands.cpp:209-243]` |
| `set_volume` | `params.volume` (0–100) | Changes current audio volume, not persisted; queues a ping confirmation at the new level. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:650-655; src/commands/SongbirdCommands.cpp:245-265]` |
| `unlock` | `params.lock_type`: `transit`, `demo`, or `all` (default `all`) | Clears the selected active lock(s), updates the lock LED, and plays a ping if a lock was cleared. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:656-670; src/commands/SongbirdCommands.cpp:267-307]` |

The wire/command name is **`unlock`** (firmware). README wording `lock_override` is stale docs — **prefer firmware**; do not invent an alias. [stated:trainer, interview 2026-10-01 conf:high] `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:656-670, reviewed 2026-10-01 conf:high]`

- **Acknowledgment:** firmware writes `command_ack.qo` with `cmd_id`, `cmd`, `status` (`ok`, `error`, or `ignored`), `message`, and `executed_at`; it requests immediate sync. `[documented:songbird-firmware/src/notecard/SongbirdNotecard.cpp:467-500, reviewed 2026-10-01 conf:high]`
- **Silence:** normal until someone sends a command. Pending commands wait until the device polls (demo: 1 second; transit: 30 seconds; storage: 60 seconds; sleep: polling disabled / wake path). `[documented:songbird-firmware/src/core/SongbirdConfig.h:245-249, reviewed 2026-10-01 conf:high]`

### `command_ack.qo` — command acknowledgment

| Field | Meaning | Type | Rungs |
| --- | --- | --- | --- |
| `cmd_id` | Correlates to command | string | `[rungs:1-2]` |
| `cmd` | Command name executed | string | `[rungs:1-2]` |
| `status` | Outcome | string (e.g. ok/error family) | `[rungs:1-2]` |
| `message` | Detail | string | `[rungs:1]` |
| `executed_at` | Execution time | number (epoch-ish) | `[rungs:1-2]` |

### `health.qo` — host health / shutdown

Observed body fields include `shutdown`, `uptime_sec`, `voltage`. Firmware can also send firmware version, boot count, GPS/sensor/notecard error counters on health notes — **not all appear in the live schema yet**. `[observed:schemas 2026-10-01 conf:medium]` `[documented:firmware health note, reviewed 2026-10-01 conf:medium]` Treat as host-side health, distinct from Notecard `_health.qo`.

---

## System Notefiles (first-class)

### `_session.qo` — connectivity sessions

- **Role:** Session begin/end — the backbone for “is it talking to Notehub?” Most useful metadata rides on the **event envelope**, not the small body. See notehub-platform for native field meaning.
- **Cadence:** Whenever the Notecard opens or closes a hub session (`req` = `session.begin` / `session.end`).
- **Songbird use:** Prefer `_session.qo` (and device last-activity) over guessing from telemetry gaps alone. Continuous demo sessions behave differently from periodic transit. **Do not treat an old session.begin as “offline.”** `[documented:platform connectivity guidance via index pointer conf:high]` `[stated:trainer, online recipe 2026-10-01 conf:high]`
- **Silence:** long gap in sessions while expecting demo connectivity = problem worth stating plainly. `[heard:trainer constraint: never paper over flaky connectivity conf:high]`

#### Body (small)

| Field | Meaning | Notes | Evidence |
| --- | --- | --- | --- |
| `opened` | Session begin marker | Present on begin notes | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-4]` |
| `closed` | Session end marker | Present on end notes | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-4]` |
| `why` | Human-readable reason | Begin: sync/modified causes; end: often `notecard ended the session` | `[observed:Events API + IQ sessions 2026-10-01 conf:high]` `[rungs:1-4]` |

#### Envelope fields Songbird answers usually need

| Field / family | Meaning | Songbird use | Evidence |
| --- | --- | --- | --- |
| `continuous` | Continuous connection mode | Demo often continuous; do not infer offline from an old begin | `[observed:IQ sessions 2026-10-01 conf:high]` `[rungs:1-4]` |
| `rssi`, `bars`, `rat`, `bearer`, `sinr`, `rsrp`, `rsrq` | Radio quality | Connectivity honesty in FE answers | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-4]` |
| `ssid`, `bssid`, `apn`, `iccid`, `cellid` | Access path | Wi‑Fi vs cell context when present | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-3]` |
| `voltage`, `power_usb`, `power_mah` | Power snapshot on session | Desk USB vs battery; not a substitute for follow-up voltage rule on `_log`/`_health` | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-4]` |
| `sn`, `sku`, `firmware_host`, `firmware_notecard` | Identity / firmware | Prefer `sn` for people; firmware strings for DFU/version talk | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-4]` |
| `tower_*`, `tri_*`, `where_*`, `best_*` | Location context on the session | **Not** the demo map pin / GPS journey — do not confuse with `_geolocate.qo` or `_track.qo` | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-3]` |
| `hub_duration_secs`, `hub_*_bytes`, `hub_sent_notes`, `hub_tcp_sessions`, `hub_tls_sessions` | Hub accounting on session.end | Secondary; useful for FE sync-volume questions | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-2]` |


### `_health.qo` — Notecard health / voltage

- **Role:** Notecard power / diagnostic notes (distinct from host `health.qo`).
- **Songbird use:** Battery truth alongside Mojo `_log.qo`. Prefer these for follow-up voltage checks — **not** `track.qo` and not alert-only. `[stated:trainer, interview 2026-10-01 conf:high]` `[observed:Events API + IQ 2026-10-01 conf:high]`

| Field | Meaning | Notes | Evidence |
| --- | --- | --- | --- |
| `voltage` | Measured voltage (V) | Compare to active `voltage_alert_low` (default **3.4 V**) for low-battery follow-up | `[observed:2026-10-01 conf:high]` `[rungs:1-4]` |
| `voltage_mode` | Power regime | Observed: `usb`, `high`, `low` — USB/desk changes whether mAh trends matter | `[observed:2026-10-01 conf:high]` `[rungs:1-4]` |
| `milliamp_hours` | Cumulative / Mojo energy | Secondary for demos; interpret with `voltage_mode` | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `method` | Event class | Often `power` | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `text` | Human power event | e.g. USB power ON/OFF | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `format`, `storage`, `template_*` | Template infrastructure | Not product sensors | `[observed:schema 2026-10-01 conf:high]` `[rungs:1]` |


### `_log.qo` — Mojo power log

- **Role:** Mojo power monitoring stream (mAh, voltage, mode).
- **Songbird use:** Battery charts and follow-up voltage. Ingest may **skip USB-powered** `_log.qo` samples for battery math. `[documented:ingest behavior, reviewed 2026-10-01 conf:high]`

| Field | Meaning | Notes | Evidence |
| --- | --- | --- | --- |
| `voltage` | Measured voltage (V) | Same follow-up rule as `_health.qo` | `[observed:2026-10-01 conf:high]` `[rungs:1-4]` |
| `voltage_mode` | Power regime | Observed `usb` / `high` / `low` | `[observed:2026-10-01 conf:high]` `[rungs:1-4]` |
| `milliamp_hours` | Energy counter | Less meaningful on USB desk power | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `method` | Event class | Often `power` | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `text` | Human power event | e.g. modem/wifi power on/off | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |


### `_track.qo` — GPS track (transit)

- **Role:** Autonomous GPS points when transit tracking is enabled; journey aggregation. **Not expected in demo** (GPS off). `[stated:trainer, interview 2026-10-01 conf:high]`
- **Clocks:** prefer capture / body `time` for the GPS point; use Notehub received time for “when did we hear from it.”
- **Critical sentinel:** `status` **`no-sat`** → companion **`gps_no_sat`** (not host `alert.qo`). `[documented:ingest + dashboard, reviewed 2026-10-01 conf:high]`
- **Aliases:** env attachments use `temperature` (full word), not `temp` from `track.qo`.

| Field | Meaning | Notes | Evidence |
| --- | --- | --- | --- |
| `journey`, `jcount` | Journey id / count | `jcount=1` starts a journey; id is unix-time style | `[observed:schema + IQ 2026-10-01 conf:high]` `[rungs:1-4]` |
| `distance`, `bearing`, `velocity` | Path metrics | meters / degrees / m/s | `[observed:2026-10-01 conf:high]` `[rungs:1-4]` |
| `dop` | Dilution of precision | Only meaningful with a real fix | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `time`, `seconds`, `motion` | Point timing / motion | Device capture context | `[observed:2026-10-01 conf:high]` `[rungs:1-3]` |
| `status` | Track status | `no-sat`, `heartbeat`, `usb`, … — not all are GPS fixes | `[observed:Events + IQ 2026-10-01 conf:high]` `[rungs:1-4]` |
| `temperature`, `humidity`, `pressure`, `voltage`, `usb`, `milliamp_hours` | Attached env/power | Optional on track notes | `[observed:2026-10-01 conf:high]` `[rungs:1-2]` |


### `_geolocate.qo` — triangulation (demo / indoor)

- **Role:** Cell/Wi‑Fi triangulation estimate — the usual **demo** map source. **Not GPS.** Coarse precision (hundreds of meters to kilometers). `[stated:trainer, interview 2026-10-01 conf:high]`
- **When expected:** demo / storage; rare as the journey story in transit (prefer `_track.qo` outdoors).
- **Do not confuse with:** `_track.qo` GPS journeys, or session envelope `tower_*` / `best_*` as “the GPS pin.”

| Field | Meaning | Notes | Evidence |
| --- | --- | --- | --- |
| `location` | Place name string | Human label for the estimate | `[observed:Events + IQ 2026-10-01 conf:high]` `[rungs:1-4]` |
| `country` | Country code / name | Accompanying place | `[observed:2026-10-01 conf:high]` `[rungs:1-4]` |
| `radios` | Radio counts map | e.g. `{"lte": N}`; Wi‑Fi AP counts when present | `[observed:Events API 2026-10-01 conf:high]` `[rungs:1-3]` |

Envelope lat/lon on the event is the triangulated point for map display — always label **source = triangulation** and **staleness**. `[stated:map recipe 2026-10-01 conf:high]`


### `_watchdog.qo` — Notehub fleet watchdog

- **Role:** Service-generated when a device exceeds fleet watchdog silence.
- **Observed fields:** `activity_event`, `activity_session`, `fleet`, `fleet_name`, `fleet_watchdog_mins`.
- **Songbird use:** Another signal for “gone quiet” — still state connectivity honestly.

### `_health_host.qo`

Name observed; **no properties in schema yet**. Record as unknown pending event sample. `[observed:schemas 2026-10-01 conf:low]`

---

## Scenarios (data side of usage)

| Situation | Expected notes | Absence means |
| --- | --- | --- |
| Live demo, demo mode, unlocked or demo-locked | Frequent `track.qo`; `_geolocate.qo`; rare/no `_track.qo` GPS; fast `command_ack.qo` after commands | Missing `track.qo` for many minutes → connectivity or power problem — say so |
| Transit, GPS outdoors | `_track.qo` with journey points; periodic `track.qo`; possible `no-sat` indoors | No `_track.qo` while claiming transit GPS → GPS off, power-save, lock/mode mismatch, or no-sat |
| Remote mode change | Env `mode` updated; next sync should reflect in `track.qo.mode` unless locked | If locks true, mode will **not** follow env — check locks first |
| Alert demo | `alert.qo` on crossing; audio on device | No `alert.qo` does not prove sensors healthy; only no new crossing |
| USB on desk | `_log.qo` may be USB mode / skipped for battery; chirps from env thresholds common | Do not call chirps a manufacturing defect without checking thresholds |

---

## Population

- Fleet **labels** observed conceptually: Sales, FAE/Field Engineering, Development, Pending Assignment, Decommissioned, Low Battery. `[observed:fleet list 2026-10-01 conf:high]`
- **Demo-ready population:** all Songbird units whose fleet **label** is not **Decommissioned** (substring match on the Notehub fleet label; emoji prefixes OK). Do **not** exclude Pending Assignment, Development, Low Battery, FAE, or Sales. Flag for follow-up (still in scope) if **low battery (from voltage)** or **no report in more than 3 days**. **Never store fleet UIDs in skills.** `[stated:trainer, interview 2026-10-01 conf:high]`

**Low-battery voltage rule (firmware):** default trip when measured voltage is **below 3.4 V** (`DEFAULT_VOLTAGE_ALERT_LOW`), configurable via env `voltage_alert_low`. Requires voltage `> 0`. Clears with **0.1 V hysteresis** (above threshold + 0.1, so ~**3.5 V** at default). Fires host `low_battery` on `alert.qo` with immediate sync. For fleet follow-up, treat **voltage below the active `voltage_alert_low` (default 3.4 V)** as the charge signal — aligned with firmware, not a separate invented band. [documented:host firmware SongbirdConfig.h / SongbirdSensors.cpp / firmware README, reviewed 2026-10-01 conf:high]


- Serial pattern `songbird-NN` identifies human-facing units; DeviceUID alone is insufficient for audience answers. `[heard:trainer conf:high]`
- Do not invent which serials are “trade-show only” without a refreshable rule.

---

## Config (shape, not secrets)

Environment variables control behavior without a firmware flash. The complete set is clear from `SongbirdEnv.h` and the fetch/default implementation. Defaults below are firmware defaults before any per-device override; numeric values are clamped to the stated range when fetched. `[documented:songbird-firmware/src/commands/SongbirdEnv.h:18-46; SongbirdEnv.cpp:17-52, 82-209; src/core/SongbirdConfig.h:169-204, reviewed 2026-10-01 conf:high]`

### Mode and timing

| Key | Type / units | Firmware default | Fetch range / values |
| --- | --- | ---: | --- |
| `mode` | string | `demo` | `demo`, `transit`, `storage`, `sleep`; ignored while transit/demo lock is active |
| `gps_interval_min` | integer, minutes | 5 | 1–1440 |
| `sync_interval_min` | integer, minutes | 15 | 1–1440 |
| `heartbeat_hours` | integer, hours | 24 | 1–168 |

Mode presets are also documented in firmware: demo `gps=1`, `sync=1`, sensitivity high; transit `5`/`15`/medium; storage `60`/`60`/low; sleep GPS/sync off and motion wake enabled. `[documented:songbird-firmware/src/commands/SongbirdEnv.cpp:267-299; src/core/SongbirdConfig.h:112-117, reviewed 2026-10-01 conf:high]`

### Alert thresholds

| Key | Type / units | Firmware default | Fetch range |
| --- | --- | ---: | --- |
| `temp_alert_high_c` | number, °C | 35 | −40 to 85 |
| `temp_alert_low_c` | number, °C | 0 | −40 to 85 |
| `humidity_alert_high` | number, %RH | 80 | 0–100 |
| `humidity_alert_low` | number, %RH | 20 | 0–100 |
| `pressure_alert_delta` | number, hPa change | 10 | 1–100 |
| `voltage_alert_low` | number, V | 3.4 | 3.3–4.2 in host firmware (API schema accepts 3.0–4.2) |

`pressure_alert_delta` is a delta from the prior pressure sample, not an absolute pressure target. `[documented:songbird-firmware/src/commands/SongbirdEnv.cpp:102-138; src/core/SongbirdConfig.h:174-180; songbird-infrastructure/lambda/api-config/index.ts:69-74, reviewed 2026-10-01 conf:high]`

### Motion, audio, commands, and device behavior

| Key | Type / units | Firmware default | Fetch range / values |
| --- | --- | ---: | --- |
| `motion_sensitivity` | string | `medium` | `low`, `medium`, `high` |
| `motion_wake_enabled` | boolean | `true` | `true`/`false` or `1`/other |
| `audio_enabled` | boolean | `true` | `true`/`false` or `1`/other |
| `audio_volume` | integer, percent | 80 | 0–100 |
| `audio_alerts_only` | boolean | `false` | `true`/`false` or `1`/other |
| `cmd_wake_enabled` | boolean | `true` | `true`/`false` or `1`/other |
| `cmd_ack_enabled` | boolean | `true` | `true`/`false` or `1`/other |
| `locate_duration_sec` | integer, seconds | 30 | 5–300 |
| `led_enabled` | boolean | `true` | `true`/`false` or `1`/other |
| `debug_mode` | boolean | `false` | `true`/`false` or `1`/other |

### Transit GPS power management

| Key | Type / units | Firmware default | Fetch range / values |
| --- | --- | ---: | --- |
| `gps_power_save_enabled` | boolean | `true` | `true`/`false` or `1`/other |
| `gps_signal_timeout_min` | integer, minutes | 15 | 10–30 |
| `gps_retry_interval_min` | integer, minutes | 30 | 5–120 |

Boolean parsing is literal: only the string `true` or `1` becomes true; any other fetched value becomes false. Missing variables leave the initialized default in place. `[documented:songbird-firmware/src/commands/SongbirdEnv.cpp:140-209, reviewed 2026-10-01 conf:high]`

Locks override `mode` env. Companion dashboard fleet defaults may sync into Notehub environment at fleet scope, but configured ≠ applied until the device fetches the change. `[documented:songbird-firmware/src/commands/SongbirdEnv.cpp:66-79; sales-enablement/setup-guide.md:49-75, reviewed 2026-10-01 conf:high]`

**Source precedence note:** `SongbirdConfig.h` is authoritative for firmware defaults. The firmware README configuration table currently lists `temp_alert_low_c=5` and `audio_volume=50`, while the compiled defaults are `0` and `80`; preserve this discrepancy as an open documentation gap rather than silently merging it. `[documented:songbird-firmware/README.md:421-437 vs src/core/SongbirdConfig.h:174-189, reviewed 2026-10-01 conf:high]`

## Derivation notes

- Pressure alert compares **delta** against last pressure, not absolute “too high altitude.”
- Journey distance/velocity/bearing are Notecard track outputs, not host BME math.
- Dashboard temperature/distance unit prefs (°C/°F, km/mi) are **presentation**, not Notefile encoding — wire temp is °C; wire distance meters.

## Open gaps (for questions worklist later)

- Confirm whether `motion` `alert.qo` is actively demoed or residual. `[assumed]`
- Project `command.qi` schema remains empty by design for this project; request body confirmed via Events API + firmware (2026-10-01).
- `_health_host.qo` purpose.
- Resolved: prefer firmware command name `unlock` over README `lock_override` (not an alias).
- Population test: exclude only fleet labels containing `Decommissioned`; include FAE/Sales/Development/Pending Assignment/Low Battery; flag voltage/silent without excluding.


## Demo alert emphasis

**Motion alerts are not used in day-to-day demos.** Keep `motion` in the wire inventory if present, but do not treat it as a primary demo alert. Prefer temperature, humidity, pressure_change, low_battery; use gps_no_sat / connectivity honesty when location is discussed. `[stated:trainer, interview 2026-10-01 conf:high]`


