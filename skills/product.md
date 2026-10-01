---
kind: product,mission,usage,audiences,vocabulary,presentation,constraints
description: Songbird as a sales/FE demo asset — mission, usage modes, vocabulary, audiences, presentation, constraints
updated: 2026-10-01T16:56:28Z
sources:
  - H1: trainer, interview 2026-09-30
  - D1: published product requirements for the sales-demo asset, restricted, reviewed 2026-10-01
  - D2: sales/FE demo FAQ, setup guide, and demo script, restricted, reviewed 2026-10-01
  - F1: host firmware and public reference implementation for the demo asset, public, reviewed 2026-10-01
  - F2: `songbird-firmware/src/commands/SongbirdEnv.h`, `SongbirdEnv.cpp`, and `src/core/SongbirdConfig.h`, public, reviewed 2026-10-01
  - F3: `songbird-firmware/src/notecard/SongbirdNotecard.cpp`, `src/commands/SongbirdCommands.cpp`, and `src/audio/SongbirdAudio.cpp`, public, reviewed 2026-10-01
  - D3: `sales-enablement/setup-guide.md`, `demo-script.md`, and `presentation-outline.md`, reviewed 2026-10-01
---

# Songbird — the product

## What it is

Songbird is a **portable battery-powered asset tracker and environmental monitor** built as an **internal sales and Field Engineering demonstration platform**. It is a real IoT device on Notecard + Notehub, not a toy UI mock. **It is not a product sold to customers**; it is a reference implementation that demonstrates capabilities customers can build with the same components. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]` `[documented:product requirements, reviewed 2026-10-01 conf:high]`

**Inside the box (physical):** Notecard (cellular + Wi-Fi + GPS/GNSS + accelerometer), host MCU on a Notecarrier CX (with a Cygnet-class STM32 MCU), BME280 environmental sensor (temperature, humidity, pressure), piezo/buzzer for audio feedback, panel button with LED for locks, LiPo battery, optional Mojo for battery power monitoring. `[documented:product requirements, reviewed 2026-10-01 conf:high]`

## Mission — what success looks like

Success for Songbird is **demo impact**, not fleet SLA for a paying customer:

1. **Power-on to cloud fast** — typically under a few minutes from battery connect to visible data. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`
2. **Remote configuration and alerts that are demonstrably real** — change behavior from the cloud without a firmware flash; threshold alerts fire and are visible. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`
3. **Honesty about the radio and the map** — never paper over flaky connectivity or present a stale or triangulated location as if it were a fresh GPS fix. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`

## How it is worked (usage)

### Operating modes (day-to-day emphasis)

| Mode | Location | Sync / behavior | Day-to-day weight |
| --- | --- | --- | --- |
| **demo** | Cell/Wi-Fi **triangulation only** (GPS off) | Continuous / immediate sync; fast command polling | **Primary** for live demos |
| **transit** | **GPS** tracking (~60 s when tracking enabled) | Periodic sync (order of minutes); journeys on `_track.qo` | **Primary** for shipping / outdoor track demos |
| **storage** | Triangulation | Slow periodic check-in (order of an hour) | Secondary; less day-to-day |
| **sleep** | Location disabled | Wake on motion (and related wake sources) | Secondary; battery-life story |

Emphasize **demo vs transit**. Do not confuse **demo triangulation** with **transit GPS**. Storage and sleep matter for power stories but are not the default demo path. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]` `[documented:product requirements / demo materials, reviewed 2026-10-01 conf:high]`

### Locks

- **Transit lock** (button single-click pattern): locks the device into transit; remote `mode` env changes are blocked while locked.
- **Demo lock** (button double-click pattern): locks into demo; same remote-mode block.
- **Mute** (triple-click pattern): toggles audio mute.

If a **remote mode change fails or appears ignored**, check **transit lock and demo lock first** before blaming Notehub, connectivity, or firmware. Dashboard shows lock badges; `track.qo` carries `transit_locked` / `demo_locked`. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]` `[documented:product requirements, reviewed 2026-10-01 conf:high]`

### Identity

- **Human / dashboard identity:** serial `songbird-NN` (and historically some units may use related serial conventions). Prefer serial in answers to people.
- **API / Notehub identity:** DeviceUID (`dev:…`). Use only when calling APIs or when serial is missing.
- Ingest rejects events without a serial number. Notecard swap can change DeviceUID while serial preserves history in the demo cloud app. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]` `[documented:product requirements, reviewed 2026-10-01 conf:high]`

### Normal vs abnormal week

- **Normal (demo week):** unit in demo (often demo-locked), charged, audible, visible on the fleet map within a minute of last sync, commands (ping/locate) respond in seconds.
- **Abnormal:** offline longer than mode implies; mode stuck because of lock; chirping from threshold alerts while sitting on a desk; map pin wrong indoors because someone expected GPS in demo; transit outdoors with `gps_no_sat` / GPS power-save.

### Alerts in demos

**Motion alerts are not used in day-to-day demos** — treat them as residual capability, not part of the demo narrative. Prefer temp, humidity, pressure_change, low_battery, and (when relevant) gps_no_sat / connectivity honesty. `[stated:trainer, interview 2026-10-01 conf:high]`

### Live Sales demo beat order (first ~5 minutes)

1. **Power-on → data in Notehub and on the dashboard in minutes**
2. **Remote environment update** (change behavior from the cloud)
3. **Command with audio** (ping/locate-style feedback the room can hear)
4. **Recent historical journey on the dashboard map**

Demos are often indoors (phone or in person). Expectation: the person demoing **always has a recent journey ready to show** — do not assume a live transit GPS track will be produced during an indoor demo. [stated:trainer, interview 2026-10-01 conf:high]


**Typical remote env change in Sales demos:** either an **alert threshold** or the device **mode** (remember locks can block mode). **Typical audio command:** `ping` (most common). [stated:trainer, interview 2026-10-01 conf:high]

### Remote demo controls (firmware-backed)

The primary Notehub environment control is `mode`: `demo`, `transit`, `storage`, or `sleep`. Firmware defaults it to `demo`; transit/demo locks block applying a remote mode change. `[documented:songbird-firmware/src/commands/SongbirdEnv.h:22-25, SongbirdEnv.cpp:66-79; src/core/SongbirdConfig.h:169-172, reviewed 2026-10-01 conf:high]`

The threshold keys most useful in a sales demo are:

| Env key | Default | Units | Demo meaning |
| --- | ---: | --- | --- |
| `temp_alert_high_c` | 35 | °C | High-temperature crossing |
| `temp_alert_low_c` | 0 | °C | Low-temperature crossing |
| `humidity_alert_high` | 80 | %RH | High-humidity crossing |
| `humidity_alert_low` | 20 | %RH | Low-humidity crossing |
| `pressure_alert_delta` | 10 | hPa | Change from prior pressure |
| `voltage_alert_low` | 3.4 | V | Low-battery crossing |

Values are clamped by firmware; alert events are emitted on `alert.qo` and synced immediately. For a live demo, lowering `temp_alert_high_c` (or another threshold) is the documented no-firmware-flash story. `[documented:songbird-firmware/src/commands/SongbirdEnv.cpp:102-138; src/core/SongbirdConfig.h:174-180; sales-enablement/demo-script.md:227-254, reviewed 2026-10-01 conf:high]`

**Source precedence note:** the firmware constants are authoritative for defaults. The firmware README table currently shows `temp_alert_low_c=5` and `audio_volume=50`, which disagree with `SongbirdConfig.h` (`0` and `80`); do not repeat those README values as firmware defaults. `[documented:songbird-firmware/README.md:421-437 vs src/core/SongbirdConfig.h:174-189, reviewed 2026-10-01 conf:high]`



## Population / demo-ready fleet

**All Songbird units should be live and demo-ready.** For fleet counts and follow-up lists, the population is **all Songbird units whose fleet label is not Decommissioned** (match the Notehub fleet label text containing `Decommissioned`; **never store fleet UIDs in skills**). FAE, Sales, Development, Pending Assignment, and Low Battery fleets stay in population. **Flag for follow-up** (do not exclude) any in-population unit that is **low battery (from voltage)** and/or **has not reported in more than 3 days**. `[stated:trainer, interview 2026-10-01 conf:high]`

**Low-battery voltage rule (firmware):** default trip when measured voltage is **below 3.4 V** (`DEFAULT_VOLTAGE_ALERT_LOW`), configurable via env `voltage_alert_low`. Requires voltage `> 0`. Clears with **0.1 V hysteresis** (above threshold + 0.1, so ~**3.5 V** at default). Fires host `low_battery` on `alert.qo` with immediate sync. For fleet follow-up, treat **voltage below the active `voltage_alert_low` (default 3.4 V)** as the charge signal — aligned with firmware, not a separate invented band. `[documented:host firmware SongbirdConfig.h / SongbirdSensors.cpp / firmware README, reviewed 2026-10-01 conf:high]`

## Audiences

| Audience | What they ask | What they may be told |
| --- | --- | --- |
| Sales | Can we show Notecard live? How fast to first data? | Full demo narrative; Songbird is not for sale |
| Field Engineering | How does mode/GPS/command/path work? | Technical depth; point at Notefiles and env keys |
| Viewer / stakeholder via public device link | Live telemetry without login | Read-only public view; no secrets |
| Anyone not listed | — | Route through Sales or Field Engineering; give nothing that implies customer-product readiness |

Relay rule: if a listed asker says the answer is for someone else, apply the **higher-consequence** audience’s constraints (usually: do not oversell precision or product status).

### Audience escalation examples (stated)

Use these as the pattern for depth and refusal — not an exhaustive FAQ. `[stated:trainer, interview 2026-10-01 conf:high]`

1. **Sales asks “Can a customer buy Songbird?”** → Stay no: it is a Blues demo asset; do not pitch it as a SKU. FE may instead talk about cloning the architecture for a customer product.
2. **Sales asks “Why won’t mode change from Notehub?”** → Short answer: check transit/demo lock first. FE gets the deeper path: env `mode`, lock flags on `track.qo`, `unlock` command, sync lag.
3. **Someone on a public device link asks for fleet-wide offline counts or env secrets** → Do not answer; route to Sales/FE. The same question from FE in Notehub → full answer.
4. **Sales wants “is the map GPS?” during an indoor demo** → Say triangulation, not GPS; do not oversell precision. FE can dig into `_geolocate.qo` vs `_track.qo`.

## Vocabulary

| Asker words | Wire / skill meaning |
| --- | --- |
| Songbird, unit, device, box | One physical demo asset |
| serial, songbird-01, songbird-NN | `sn` / serial_number — preferred identity |
| DeviceUID, Notehub device | `dev:…` — API only |
| Demo mode | `mode=demo`; triangulation location; fast sync |
| Transit mode | `mode=transit`; GPS `_track.qo` journeys |
| Triangulation / indoor location | `_geolocate.qo` / cell+Wi-Fi estimate — **not GPS** |
| GPS / journey / track | `_track.qo` in transit; velocity, bearing, journey id |
| Temp / temperature alert | `alert.qo` types `temp_high` / `temp_low` (category “temp”) |
| Humidity alert | `humidity_high` / `humidity_low` |
| Pressure change | `pressure_change` |
| Low battery | `low_battery` (and related health/power paths) |
| Motion alert | `motion` |
| No GPS / no satellites | Device/cloud flag & alert **`gps_no_sat`** from `_track.qo` status `no-sat` (not a host `alert.qo` template type) |
| Locked / won’t take mode | `transit_locked` or `demo_locked` |
| Ping / locate | Inbound `command.qi`; ack on `command_ack.qo`; audio on device |

## Presentation

| Question family | Preferred shape |
| --- | --- |
| Is this unit OK / online / what mode? | **Sentence** with serial, mode, lock state, last-heard (UTC), caveats |
| Where is it? | **Map**, but label **source** (GPS vs triangulation) and **staleness**; refuse GPS-precision wording for demo |
| Temp/humidity over time | **Series** (°C / %RH); gaps are gaps, not zero |
| Which units are alerting? | **Ranking / list** by serial with alert type |
| Did the mode change apply? | **Decision sentence**: locks → env → last `track.qo.mode` |
| Fleet “how many online” | **Count** with denominator rule (see population in `notefiles.md`); UTC window |

Precision: temperature to tenths °C is enough for demo talk; location precision must match source (meters only for GPS with good DOP; triangulation is hundreds of meters to kilometers).

## Constraints — what an answer must never claim

1. **Never claim Songbird is a customer SKU / product for purchase.** It is a sales/FE demo and reference. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`
2. **Never paper over flaky connectivity** — if sessions stopped, sync is late, or the unit is silent beyond its mode’s expected cadence, say so. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`
3. **Never present stale location as current**, and **never call demo triangulation a GPS fix**. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`
4. **Never blame “remote config broken” before checking transit/demo locks.** `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`
5. Do not invent contractual SLAs; this fleet is internal demo hardware.
6. Do not expose tokens, keys, or private dashboard credentials in answers.

## Dimensions this product does not have (in Notehub alone)

Work orders, customer contracts, warranty entitlements, technician dispatch tickets, and commercial inventory SKUs are **out of scope**. Device assignment and fleet labels in the companion dashboard are operational convenience for Sales/FE, not a CMMS.
