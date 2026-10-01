---
kind: recipe
description: Songbird verified recipes — question to data path and answer shape
updated: 2026-10-01T17:26:26Z
sources:
  - H1: trainer, interview 2026-10-01
  - S1: project Notefile schemas and skills inventory, reviewed 2026-10-01
---

# Songbird — recipes

## Recipe: unit online / mode / locks

**Status:** verified (trainer read-back 2026-10-01)

**Asker words (examples):** “Is songbird-NN online?” “What mode is it in?” “Any locks?” “Is this unit OK right now?”

**Answer shape:** one sentence with serial, online/stale judgment, `mode`, lock state, last heard (UTC), plus any caveat if the latest note is missing or very old.

**Meaning bridge:**
1. Identify the unit by serial `songbird-NN` in the answer; use DeviceUID only for APIs.
2. Take this device’s **latest** `track.qo` by Notehub **received** time (UTC). That note is the source of current `mode`, `transit_locked`, and `demo_locked`.
3. Judge **online / heard recently** from last received activity / `track.qo` age — **not** from an old `_session.qo` session.begin. Continuous demo sessions can leave an old begin while the unit is still connected.
4. Silence vs mode (inherit `notefiles.md` scenarios):
   - **demo:** many minutes without `track.qo` is abnormal — say so.
   - **transit / storage:** longer gaps can be normal for the mode.
   - **>3 days** with no report: still answer the question, and **flag for follow-up** (population rule in `product.md` / `notefiles.md`).
5. If there is no usable latest `track.qo`, say that plainly; do not invent mode or locks.

**Dependencies:** `product.md` identity + population follow-up; `notefiles.md` `track.qo` fields and mode scenarios; never paper over flaky connectivity (`product.md` constraints).

**Proof:** answer names serial, cites latest `track.qo` received time (UTC), reports `mode` and both lock flags, and states the online/stale judgment with the mode-appropriate silence caveat when relevant.

## Recipe: why won’t remote mode change

**Status:** verified (trainer read-back 2026-10-01)

**Asker words (examples):** “Why won’t mode change from Notehub?” “I set mode to transit and nothing happened.” “Remote mode ignored.”

**Answer shape:** decision sentence — locks → env `mode` → latest `track.qo.mode` → sync lag / offline. Sales: short lock-first answer. FE: deeper path including `unlock`.

**Meaning bridge:**
1. Take latest `track.qo` (received UTC). If `transit_locked` or `demo_locked` is true, **that is why** remote `mode` env changes are blocked. Say so first; do not blame Notehub or firmware yet.
2. If unlocked, compare project/fleet/device env `mode` to `track.qo.mode`. Env ahead of applied mode with no lock → waiting on device sync (or unit silent/offline per the online recipe).
3. FE depth: env `mode`, lock flags on `track.qo`, `unlock` command, sync lag. Audience escalation in `product.md`.

**Dependencies:** `product.md` locks + escalation #2; `notefiles.md` remote mode-change scenario; online/mode/locks recipe for silence judgment.

**Proof:** answer checks locks before any other cause; names serial; cites latest `track.qo` lock flags and mode vs env when relevant.

## Recipe: low-battery or silent >3 days (follow-up)

**Status:** verified (trainer read-back 2026-10-01)

**Asker words (examples):** “Which units need follow-up?” “Who is low battery?” “Who hasn’t reported in days?” “What’s not demo-ready?”

**Answer shape:** list/ranking by serial with flag reason (low voltage and/or silent >3 days). Units can carry both flags.

**Meaning bridge:**
1. **Population:** all Songbird units whose fleet **label** does not contain **Decommissioned** (no fleet UIDs in skills). FAE/Sales/Development/Pending Assignment/Low Battery stay in. Do not exclude silent or low-battery units — flag them for follow-up.
2. **Silent:** last heard / no report **>3 days** (UTC received) → flag follow-up.
3. **Low battery:** measured voltage below the active `voltage_alert_low` (firmware default **3.4 V**, clear ~**3.5 V** with +0.1 V hysteresis). Source **`_log.qo` / `_health.qo`**, not alert-only and not `track.qo` (voltage is not on current `track.qo`).
4. Still answer in demo-ready intent: flag to restore, don’t drop from the fleet story.

**Dependencies:** `product.md` population + voltage rule; `notefiles.md` power Notefiles; online recipe for last-heard.

**Proof:** denominator excludes only Decommissioned-labeled fleets; each flagged serial names silent and/or voltage reason with threshold.

## Recipe: map pin GPS vs triangulation

**Status:** verified (trainer read-back 2026-10-01)

**Asker words (examples):** “Is the map GPS?” “Where is it exactly?” “Is this pin precise?”

**Answer shape:** sentence (and map if shown) naming **source** and **staleness**; never call demo triangulation a GPS fix.

**Meaning bridge:**
1. Read latest `track.qo.mode`. **demo** / **storage** → expect triangulation via `_geolocate.qo`. **transit** → GPS journeys on `_track.qo` when tracking.
2. Prefer the Notefile that produced the pin; if only a stale point exists, say stale — never present it as current.
3. Sales indoor demo: triangulation, do not oversell precision. FE: dig into `_geolocate.qo` vs `_track.qo` (audience escalation #4).

**Dependencies:** `product.md` modes + constraints; `notefiles.md` `_geolocate.qo` / `_track.qo` scenarios.

**Proof:** answer names serial, mode, location source, and staleness when relevant.

## Recipe: did ping / audio command work?

**Status:** verified (trainer read-back 2026-10-01)

**Asker words (examples):** “Did the ping work?” “Did they hear it?” “Did the audio command go through?”

**Answer shape:** decision sentence — serial, `cmd`, ack `status`/`message`, timing (UTC).

**Meaning bridge:**
1. Find matching `command_ack.qo` for the unit (`cmd=ping` for the usual Sales demo; correlate `cmd_id` to inbound `command_id` when known).
2. Interpret status: `ok` + “Ping played” → worked; `ignored` + “Audio disabled” → command reached the device, audio off; `error` → say the message plainly.
3. No ack after a reasonable wait → treat as offline/silent or not yet synced (online recipe), not “ping broken” by default.
4. Request body path remains `command.qi` (`command_id`/`cmd`/`params`); outcomes live on `command_ack.qo`.

**Dependencies:** `notefiles.md` command.qi / command_ack; online recipe for silence; Sales demo beat uses ping.

**Proof:** names serial, cites ack status/message (or absence), and UTC time.

## Recipe: which units are alerting?

**Status:** verified (trainer read-back 2026-10-01)

**Asker words (examples):** “Who is alerting?” “Any threshold alerts?” “gps_no_sat anywhere?”

**Answer shape:** list/ranking by serial with alert type and UTC time/window.

**Meaning bridge:**
1. Population: exclude fleet labels containing **Decommissioned** only.
2. Primary wire: `alert.qo` (`temp_high`/`temp_low`, humidity highs/lows, `pressure_change`, `low_battery`). **Motion alerts are not used in demos** — omit from demo narrative unless asked.
3. Also include **`gps_no_sat`** derived from `_track.qo` status `no-sat` (not a host `alert.qo` type).
4. Do not invent clears; gaps are gaps.

**Dependencies:** `notefiles.md` alerts + `_track` sentinel; population rule; presentation ranking shape.

**Proof:** each listed serial names alert type/source and UTC time; denominator excludes only Decommissioned.

## Recipe: show a recent historical journey for demo

**Status:** verified (trainer read-back 2026-10-01; map-in-chat 2026-10-01)

**Asker words (examples):** “Show a journey on the map.” “Do we have a track ready for the demo?”

**Answer shape:** **map image attached in chat** + short sentence — serial, journey id/time (UTC), source = **GPS `_track.qo`**, staleness.

**Meaning bridge:**
1. Prefer a recent completed `_track.qo` journey for the named unit (or any in-population demo-ready unit if unnamed).
2. **Plot in chat:** take the GPS lon/lat points for that journey, render a polyline with start/end markers as a map image, and **attach it** with the sentence. Do not answer with coordinates-only.
3. Indoor Sales demos: do **not** expect a live transit GPS track during the pitch — always have a **historical** journey ready (and plot that).
4. Never present or plot `_geolocate.qo` triangulation or session `tower_*`/`best_*` as the journey.

**Dependencies:** Sales demo beat; `_track.qo` rungs; map GPS vs triangulation recipe.

**Proof:** map image attached + serial + journey identity/time + explicitly GPS `_track` source.

## Recipe: daily fleet activity digest

**Status:** verified (trainer request 2026-10-01; weekday morning routine)

**Asker words (examples):** “How’s the fleet today?” “Daily activity summary.” “What needs follow-up?” “Fleet health digest.”

**Answer shape:** short digest — **headline stats**, then **follow-up serials** (or “none”). Times for the asker in America/Chicago; data windows in UTC unless they override.

**Meaning bridge:**
1. **Population:** all Songbird units whose fleet **label** does not contain **Decommissioned** (no fleet UIDs in skills). Silent and low-battery units stay in population and are flagged, not dropped.
2. **Headline stats** (in-population only):
   - Device count
   - Heard in the last **24 hours** vs not (prefer latest `track.qo` / activity; do not treat an old `session.begin` as proof of offline)
   - Count **silent >3 days**
   - Count **low battery** — latest `_log.qo` / `_health.qo` voltage **&lt; 3.4 V** (firmware default `voltage_alert_low`; env may override)
3. **Follow-up list:** each flagged serial with reason (`silent Nd` and/or `V=x.xx`). Prefer `songbird-NN`.
4. Optional extras if cheap: `alert.qo` volume in 24h; units with `_track` status `no-sat` → `gps_no_sat`.
5. Cadence: weekday morning digest is the standing delivery; on-demand asks use the same shape.

**Dependencies:** population + low-battery/silent recipes; `product.md` demo-ready fleet rule; `notefiles.md` power + track.

**Proof:** stats use in-population denominator; follow-ups name serial + reason; Decommissioned excluded only.
