---
kind: index
description: Songbird project skill index — product identity, documentation pointers, answerability, training status
updated: 2026-10-01T17:26:26Z
sources:
  - H1: trainer, interview 2026-09-30
  - D1: published product requirements for the sales-demo asset, restricted, reviewed 2026-10-01
  - D2: sales/FE demo FAQ, setup guide, and demo script, restricted, reviewed 2026-10-01
  - F1: host firmware and public reference implementation for the demo asset, public, reviewed 2026-10-01
  - F2: `songbird-firmware/src/commands/SongbirdEnv.h`, `SongbirdEnv.cpp`, and `src/core/SongbirdConfig.h`, public, reviewed 2026-10-01
  - F3: `songbird-firmware/src/notecard/SongbirdNotecard.cpp`, `src/commands/SongbirdCommands.cpp`, and `src/audio/SongbirdAudio.cpp`, public, reviewed 2026-10-01
  - D3: `sales-enablement/setup-guide.md`, `demo-script.md`, and `presentation-outline.md`, reviewed 2026-10-01
  - S1: project Notefile schemas observed 2026-10-01
---

# Songbird — start here

## Product in words

**Songbird** is a portable, battery-powered **sales and field-engineering demonstration asset** — not a customer product for sale. It is a working reference device that shows what Notecard + Notehub can do: instant cellular connect, environmental sensing, location (triangulation indoors / GPS in transit), remote configuration via environment variables, cloud-to-device commands with audio feedback, and threshold alerts. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`

People identify units by **serial number** in the form `songbird-NN` (zero-padded number). DeviceUID is for APIs and Notehub internals only — never as the human name for a unit. `[stated:trainer, interview 2026-09-30 / read-back 2026-10-01 conf:high]`

Default timezone for answers, dashboards, and query windows in this skill set: **UTC**, unless the asker explicitly overrides.

## Documentation pointers (only URLs these skills may carry)

- Notehub API reference: https://dev.blues.io/api-reference/notehub-api
- Notehub OpenAPI: https://raw.githubusercontent.com/blues/notehub-js/main/openapi.yaml
- Shared native Notecard/Notehub field meaning: https://notehub.md/notehub-platform/SKILL.md
- If this project is Notehub IQ–enabled, IQ MCP install and specification live with the Notehub IQ docs; do not treat presence of IQ as asserted by this index.

## Skill map

| File | Kinds | What it holds |
| --- | --- | --- |
| `product.md` | product, mission, usage, audiences, vocabulary, presentation, constraints | What Songbird is, how it is worked (demo vs transit), who asks, words, answer shapes, hard limits |
| `notefiles.md` | notefiles, derivation, sentinels, scenarios, population, config | App Notefiles **and** system Notefiles (`_session`, `_health`, `_log`, `_track`, `_geolocate`, …), field meanings, mode→data scenarios |
| `recipes.md` | recipe | Verified question→data bridges |

Unmatched questions: answer from `product.md` + `notefiles.md` inventory and population rules, or refuse — never stretch a missing recipe silently.

## What is answerable today (and what is not)

**Can answer in product language (bounded):**

- What is Songbird / is it for sale / who uses it
- What demo vs transit vs storage vs sleep mean for location source, sync, and power
- Why a remote mode change did not take (check transit/demo locks first)
- What primary alert families mean, and where on the wire they live
- Which Notefile carries telemetry, GPS track, triangulation, alerts, commands, power, session
- How serial vs DeviceUID should be used when naming a device
- Unit online / mode / locks (verified recipe in `recipes.md`)

**Conditional / thin:**

- Exact live thresholds and env values per device (configured, not fixed in skills) — read env / latest `track.qo`
- Fleet membership meaning beyond label names (assignment rules not fully trained)
- Full recipe set (current-state and fleet-period recipes not yet written as `recipe` files)

**Must never claim:**

- That connectivity is fine when sessions or sync evidence say otherwise
- That a map pin is GPS-precise when the unit is in demo (triangulation)
- That a stale location is current
- That Songbird is a commercial end-customer product

## Source confidentiality

Internal requirements and any restricted enablement material remain **restricted**. Public firmware and repo documentation may be cited by repo-relative source path in `[documented:...]` claims; do not copy restricted excerpts or expose secrets.

## Training status

**Skill 1 + Skill 2 published to Notehub** (2026-10-01). Trainer reviewed and edited drafts before upload. Mission, identity, demo/transit emphasis, lock troubleshooting, and honesty about connectivity/location were **read back and promoted to `stated`** (2026-10-01). **Motion alerts are not used in demos** (`stated`). Primary env/battery alert emphasis still stands; motion is residual.

**Solid:** Sales demo beat order; product identity; operating-mode location semantics; serial naming; lock-blocks-remote-mode; Notefile roster including system files; alert wire types vs cloud-derived `gps_no_sat`.

**Thin / not yet reached:** (none called out — ask trainer for next gap).

**Solid also:** Sales demo beat order (power-on→dashboard, remote env, command+audio, recent journey ready — demos often indoor).

**Solid also:** demo env = alert threshold or mode; demo audio command = ping.

**Solid also:** silent follow-up if no report **>3 days**; low-battery follow-up from **voltage** (not alert-only).

**Solid also:** firmware low-battery default **3.4 V** (`voltage_alert_low`), clear ~**3.5 V** (+0.1 V hysteresis); follow-up uses that voltage rule.

**Solid also:** complete firmware environment-key inventory with defaults/units/ranges, mode/threshold demo controls, and `command.qi` body/command details including ping audio behavior.

**Solid also:** audience escalation examples (buy Songbird / mode stuck / public-link fleet secrets / indoor map GPS vs triangulation) — Sales short answers vs FE depth vs refuse-and-route.

**Solid also:** current-state recipe — unit online / mode / locks (`recipes.md`).

**Solid also:** mode-change failure recipe — locks first, then env vs `track.qo.mode` (`recipes.md`).

**Solid also:** low-battery / silent >3 days follow-up recipe; population = all units except decommissioned fleet (`recipes.md` / `product.md`).

**Solid also:** map pin GPS vs triangulation recipe (`recipes.md`).

**Solid also:** `command.qi` request body confirmed via Notehub Events API + firmware (`command_id`/`cmd`/`params`/`sent_at`); project schema still empty — use events/acks, not schema null.

**Solid also:** `_session.qo` body + envelope field rungs for connectivity (continuous, radio, power snapshot, firmware; tower/tri/where ≠ map pin).

**Solid also:** `_log.qo` / `_health.qo` power field rungs (`voltage`, `voltage_mode` usb/high/low, mAh, method/text).

**Solid also:** `_track.qo` GPS journey field rungs (journey metrics, `no-sat`→`gps_no_sat`, demo = rare/no track).

**Solid also:** `_geolocate.qo` triangulation field rungs (location/country/radios; not GPS).

**Solid also:** population excludes only fleet labels containing `Decommissioned` (no UIDs); other fleets stay in; flag voltage/silent.

**Solid also:** ping / audio command recipe via `command_ack.qo` (`recipes.md`).

**Solid also:** alerting recipe (`alert.qo` + `gps_no_sat` from `_track`).

**Solid also:** historical journey demo recipe (`_track.qo`, not triangulation; **map image in chat**).

**Solid also:** daily fleet activity digest recipe (`recipes.md`; weekday morning routine).

**Open follow-up:** README vs firmware defaults for `temp_alert_low_c`/`audio_volume` — prefer firmware; `unlock` (not README `lock_override`) is authoritative.
