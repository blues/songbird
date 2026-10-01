# Songbird Monorepo — Critical Engineering Analysis

**Date:** 2026-07-02
**Scope:** Full monorepo — `songbird-firmware/` (STM32/FreeRTOS/C++), `songbird-infrastructure/` (AWS CDK + Lambda/TS), `songbird-dashboard/` (React 18 + Vite/TS).
**Method:** Three parallel domain review agents (each read CLAUDE.md + traced source with file:line evidence and ran the real build/test/lint tooling) plus an orchestrator-run cross-component contract trace. Read-only: no source modified, nothing deployed or committed.
**Evidence standard:** Every issue below cites a real file:line that was actually read. Dimensions found clean are stated as such — nothing was invented.

---

## (a) Executive Summary

Songbird is a well-structured demo platform with genuinely good practices in several areas (clean firmware ISR/memory discipline, disciplined `api-commands` authorization, solid S3/CloudFront hardening, correct runtime-config secret loading in the dashboard). **All three components build; the infra test suite (451 tests) and dashboard test suite (394 tests) pass; firmware compiles cleanly on both environments.**

However, the review surfaced **four Critical and eleven High-severity issues**, concentrated in two themes:

1. **Backend authorization gaps (most urgent).** The Config Lambda enforces *no* authorization (`api-config`), and the `/v1/ingest` endpoint has *no* authorizer or shared-secret. Combined with open self-signup, **any internet user can register and remotely reconfigure/lock/Wi‑Fi-provision any device, or forge arbitrary device events** (spoof telemetry, fabricate alerts that email a real address, force bogus Notecard swaps). For a sales-demo fleet these are direct-sabotage vectors. The dashboard's role gating is cosmetic (client-side only), so backend enforcement is the *only* real control — and it is missing on these paths.

2. **Silent contract/persistence breakage.** Firmware state persistence across sleep/brownout is **completely non-functional** (two Critical stubs) — a device shipped "locked" comes back unlocked. Firmware emits app-level `health.qo` (including the brownout shutdown note) that the ingest Lambda **never handles**, so battery/health/shutdown signals silently vanish. Ingest is non-idempotent, so Notehub retries create duplicate telemetry/journeys.

The dashboard's `npm run lint` gate is **100% non-functional** (no ESLint config exists at all), meaning zero lint coverage has been running in CI — a process finding that likely masks latent issues.

**Priority order:** fix the two auth Criticals (infra) first — they're internet-exploitable and low-effort; then the firmware persistence Criticals; then the ingest idempotency + `health.qo` contract gap; then the lint gate.

**Tallies:** Critical ×4 · High ×11 · Medium ×15 · Low ×9. (Firmware: 2C/5H/9M/4L · Infra: 2C/4H/8M/4L(+2 mixed) · Dashboard: 1C/3H/6M/6L.)

---

## (b) Consolidated Issue Table (sorted by severity)

### 🔴 Critical

| # | Component | File:line | Issue | Why it matters | Recommended fix |
|---|---|---|---|---|---|
| C1 | Infra | `lambda/api-config/index.ts:91-150` | Config handler does **no authorization** — no `isAdmin`/owner/group check anywhere. Any authenticated user can `PUT /v1/devices/{sn}/config`, `/wifi`, `/fleets/{uid}/config`. CDK route comments falsely claim enforcement (`api-construct.ts:529,611`). | With self-signup→Viewer (`auth-construct.ts:40`), **anyone on the internet can register and remotely reconfigure/lock any device** and push Wi‑Fi creds to the Notecard. Fleet sabotage. | Add JWT group/owner enforcement mirroring `api-commands` (`isAdmin`/`isDeviceOwner`). Gate fleet config→Admin, device config→Admin+owner. |
| C2 | Infra | `lib/api-construct.ts:736-741` + `api-ingest/index.ts:135` | `/v1/ingest` has **no authorizer and no shared-secret/HMAC**; handler trusts the raw JSON body. | Anyone with the URL can forge device events: spoof telemetry/GPS, fabricate alerts (→ real SNS email to brandon@blues.com), force a bogus Notecard swap by replaying a known `sn` with a new `device`. | Require a Notehub-configured shared-secret header (constant-time compare) or mTLS/WAF IP allowlist; reject unsigned requests before any write. |
| C3 | Firmware | `SongbirdNotecard.cpp:1268-1274` | `notecardGetSleepPayload()` is a stub that **always returns 0**; `stateRestore()` (`SongbirdState.cpp:97-107`) therefore always fails → **every boot is a cold boot**. | Warm-boot, lock persistence, boot counting, brownout/uptime accumulation, `preTransitMode`/`preDemoMode` restore are all silently dead. A demo device shipped "locked" returns unlocked. | Implement `card.attn` wake-payload retrieval (base64-decode into buffer), or drop warm-boot and document it. |
| C4 | Firmware | `SongbirdNotecard.cpp:1224-1227` | Sleep payload written as `JAddStringToObject(req,"payload",(const char*)&s_state)` — raw binary struct as a C-string, **no base64** (comment admits it). | `JAddStringToObject` truncates at the first `0x00`; the state struct is full of zero bytes → saved state is corrupt even if retrieval worked. Save side broken independent of C3. | Base64-encode (`JB64Encode`/note-c helper) per the `card.attn` payload API. |

### 🟠 High

| # | Component | File:line | Issue | Why it matters | Recommended fix |
|---|---|---|---|---|---|
| H1 | Infra | `lambda/analytics/chat-query.ts:454,469,490-498,436` | `userEmail` and `deviceSerialNumbers` taken from the **client body**, not JWT claims. | Authenticated IDOR: any user reads another's device data / chat history by passing someone else's identity/scope. Defeats the per-device access model. | Derive `userEmail` from `claims.email`; resolve accessible serials server-side; ignore client identity/scope. |
| H2 | Dashboard | `package.json:10` + repo root | `npm run lint` runs ESLint but **no ESLint config exists anywhere** (no `.eslintrc*`/`eslint.config.*`). Lint aborts "couldn't find a configuration file" (exit 2). | Lint is a documented CI gate (CLAUDE.md:244); it is **100% non-functional** — zero lint coverage, `react-hooks/exhaustive-deps` never runs. *(Independently confirmed by orchestrator.)* | Add a flat `eslint.config.js` with `@typescript-eslint` + `react-hooks` + `react-refresh`; verify `npm run lint` exits 0. |
| H3 | Firmware | `SongbirdPower.cpp` (whole) + `SongbirdConfig.h:58` | **No IWDG watchdog is ever started**, yet `powerInit` decodes `RCC_CSR_IWDGRSTF` as if one exists. | A hung task (I2C lockup, stuck mutex) never recovers on an unattended battery device. | Enable IWDG with a period > longest legit blocking op (Notecard 10s); refresh from Main/NotecardTask. |
| H4 | Firmware | `SongbirdSync.cpp:47`, `SongbirdTasks.cpp:364`, `SongbirdState.cpp:86-88,161-188,266-271` | `g_stateMutex` created but **never used**. Setters use `taskENTER_CRITICAL()`; `stateGet()` hands out a raw `s_state*` and readers touch multi-byte fields with no sync. | Data races on composite reads (`lastShutdownReason[16]`, `totalUptimeSec`) vs critical-section writers; trivial getters also globally disable interrupts incl. the PVD safety IRQ. | Use `g_stateMutex` consistently, or wrap composite read/modify in critical sections and drop raw-pointer exposure. |
| H5 | Firmware | `SongbirdTasks.cpp:1016-1150` | NotecardTask (priority 4, highest) holds `g_i2cMutex` across the **entire** periodic block: GPS status + up to two `card.location.mode` writes + `notecardSync`, each up to 10s. | AudioTask/SensorTask/CommandTask/EnvTask time out on `g_i2cMutex` silently during a slow modem sync → dropped beeps, missed reads, stalled command polling. | Acquire/release the mutex per individual Notecard request; keep hold times bounded. |
| H6 | Firmware | `SongbirdNotecard.cpp:579-682`, `SongbirdTasks.cpp:951` | `Command cmd;` stack-allocated, **not zero-initialized**; `notecardGetCommand` fills only matched fields. `play_melody` w/o `melody` key → garbage `melodyName`; >15-char melody → non-null-terminated `strncpy` (`:639-641`) → `strcmp` over-read. | Uninitialized/unterminated buffer read **reachable from cloud input** (`command.qi`). Memory-safety bug. | `memset(cmd,0,sizeof(*cmd))` at top of `notecardGetCommand`; always null-terminate after `strncpy`. |
| H7 | Firmware / Infra | `SongbirdNotecard.cpp:414` vs `203-212`; ingest `api-ingest/index.ts:258` | `track.qo` note.add adds `gps_power_saving` (`:414`) but it is **not in the compact template** (`:203-212`). With `format:"compact"`, keys absent from the template are dropped by the Notecard. | Ingest tries to read `body.gps_power_saving` (`:258`) but will **never receive it**. Silent firmware↔cloud contract drift; GPS-power-save alert never fires. *(Cross-component; orchestrator-verified both ends.)* | Add `gps_power_saving`(TBOOL) to the track template (or stop sending it); always send both lock booleans for deterministic compact encoding. |
| H8 | Infra | `lib/api-construct.ts:359` | `MAPBOX_TOKEN: mapboxSecret.secretValue.unsafeUnwrap()` injects the secret as a **plaintext Lambda env var** (confirmed in synth: `{{resolve:secretsmanager:...}}` in `Environment.Variables`). | Readable by anyone with `lambda:GetFunctionConfiguration`; bypasses Secrets Manager access control/rotation. | Fetch at runtime via `SecretsManagerClient` + `grantRead`, like the Notehub-token pattern (`api-notehub/index.ts:26-46`). |
| H9 | Infra | `lambda/api-ingest/index.ts:119-282,449-455,277` | Ingest is **non-idempotent / not partial-failure safe**: ~10 sequential writes; any error → 500 → Notehub retries → re-runs succeeded `PutCommand`s. Records keyed by `device_uid`+`timestamp`, not the unique `event` id. | Retried/duplicate deliveries create duplicate telemetry, locations, journey points — inflated counts and cost. | Use Notehub `event` id as idempotency key (`attribute_not_exists`); return 200 for permanently-malformed input to stop retry storms. |
| H10 | Infra | `lib/storage-construct.ts:46-52,102-110,140-149`, `bin/songbird.ts:31` | `removalPolicy: DESTROY` on **every** table; PITR enabled **only** on `DevicesTable`. App tagged `Environment: production`. | A stack delete/replace wipes all telemetry/alert/journey/**alias** history with no restore. Alias-table loss destroys the only serial↔UID mapping. | Enable PITR on all stateful tables; `RETAIN` for non-ephemeral, or gate DESTROY behind a demo flag. |
| H11 | Dashboard | `public/config.json:6` + `.gitignore` | A real-looking Mapbox token + populated Cognito pool IDs are present in git-tracked `public/config.json`; `.gitignore` has **no** entry for `config.json`/`.env`. (`.example` template exists but nothing prevents the real file being committed.) | Leaks environment topology; unrestricted `pk.` token is abusable/billable. | Add `public/config.json` + `.env*` to `.gitignore`; `git rm --cached` if tracked; scope/rotate the token by URL. |

### 🟡 Medium

| # | Component | File:line | Issue | Recommended fix |
|---|---|---|---|---|
| M1 | Firmware/Infra | `SongbirdNotecard.cpp:513-573` | `health.qo` has **two body shapes** (health vs shutdown) on one file, **no template registered**, and ingest only handles `_health.qo` (underscore) — app `health.qo` is **dropped**. *(See cross-component X1.)* | Split into `health.qo`+`shutdown.qo` or unify schema + register template; add an ingest branch for app `health.qo`. |
| M2 | Firmware | `SongbirdNotecard.cpp:207,242,278` | Templates declare `_time`(TINT32) but no note.add ever sets it; device time never transmitted. | Populate `_time` from `SensorData.timestamp`, or remove and rely on event `when`. |
| M3 | Firmware | `SongbirdTasks.cpp:1142-1147` | Demo mode issues explicit `hub.sync` every 5s though `hub.set` already uses `mode:"continuous",sync:true`. | Drop the periodic sync in demo mode; continuous already syncs. Saves battery/cell. |
| M4 | Firmware | `SongbirdTasks.cpp:769-795,954-957,1184-1187` | I2C acquire failures **swallowed** — no else/counter/retry; `readSuccess` stays false silently. | Count/report acquire timeouts (feed `sensor_errors`/`notecard_errors`); add backoff. |
| M5 | Firmware | `SongbirdTasks.cpp:372-375` | MainTask holds `g_i2cMutex` across `notecardWaitConnection()` (up to 30s). | Release mutex between connection polls. |
| M6 | Firmware | `SongbirdConfig.h:88-94` | `STACK_AUDIO`=256 words (1KB) is tight for the audio→I2C call chain; no non-debug headroom check. | Verify high-water marks on HW; bump to 384-512 words unless measured safe. |
| M7 | Firmware | `SongbirdNotecard.cpp:585-682` | `notecardGetCommand` processes **one** command per poll, never loops. | Loop `note.get` until empty within a bounded budget. |
| M8 | Firmware/Infra | `SongbirdCommands.cpp:62`, `SongbirdNotecard.cpp:499` | `executed_at = millis()/1000` is **uptime, not epoch**; sent in `command_ack.qo`; ingest stores it (`:1080-1111`). | Use `card.time` or rely on event `when`; dashboard must not render as wall-clock. |
| M9 | Infra | `lib/api-construct.ts:395-407` | CORS `allowOrigins:['*']` with `Authorization` header on per-user data. | Restrict to the dashboard domain(s). |
| M10 | Infra | `lambda/api-config/index.ts:400` | Wi‑Fi value built by raw interpolation `["${ssid}","${password}"]` — not JSON-escaped. | Use `JSON.stringify([ssid,password])`; validate charset/length. |
| M11 | Infra | `lambda/shared/device-lookup.ts:171-224` | `handleDeviceAlias` read-then-write with **no conditional/optimistic lock**; `updateAliasOnSwap` blindly `list_append`s → TOCTOU on concurrent same-serial events. | Add `ConditionExpression (device_uid = :expected_old)` + retry; dedup `previous_device_uids`. |
| M12 | Infra | `lib/storage-construct.ts:166-177` | Alerts `status-index` PK is `acknowledged` (cardinality 2) → hot partition as volume grows. | Composite/sharded PK or query per-device via `device-index`. |
| M13 | Infra | many (`api-activity` ×6, `api-devices:129`, `api-alerts:148`, `api-users:105,147`, `api-commands:416`, `chat-query.ts:488`) | Multiple full-table `ScanCommand`s; activity feed scans several tables per request. *(Orchestrator-confirmed.)* | Replace with GSI queries; model a time-sorted ActivityFeed table. |
| M14 | Infra | `lib/api-construct.ts` (no WAF) + `api-public-device/index.ts:28-137,237` | No WAF/throttling; unauthenticated public endpoint does resolve+query+audit-put per hit; 404-vs-200 enables serial enumeration. | Add API GW throttling + WAF rate rules; per-IP limits; signed share tokens. |
| M15 | Infra | `api-ingest:120,136`, `api-devices:37`, `api-config:92`, `api-commands:117`, `api-notehub:118`, `api-public-device:29` | `console.log(JSON.stringify(event))` logs full request incl. `Authorization` JWT and raw bodies → CloudWatch (14-day). | Redact `Authorization` + sensitive body fields; log minimal structured fields. |
| M16 | Infra | `lambda/analytics/chat-query.ts:111-137,301-317` | LLM-SQL safety relies on a keyword **blocklist** + regex + string rewriting of model output. | Parameterized/allow-listed templates; read-only Postgres role + row-level security; enforce device filter in controlled SQL. |
| M17 | Dashboard | `src/pages/DeviceDetail.tsx:1-924` | God component (924 lines, ~20 hooks); repeated filter blocks (`:216,227,238`) re-run over ≤10k rows with no `useMemo` → re-render storms. | Split into sub-components; memoize filters keyed on `[data,selectedJourney]`. |
| M18 | Dashboard | `src/pages/Commands.tsx:218-227` | `handleSendCommand` awaits in a loop with **no try/catch**; one failure aborts remaining sends + unhandled rejection. | `Promise.allSettled` / per-send try-catch; surface per-device success/failure. |
| M19 | Dashboard | `CommandPanel.tsx:73-87`, `Alerts.tsx:154-161`, `DeviceDetail.tsx:838` | Fire-and-forget `mutation.mutate` with **no `onError`** — command/ack failures invisible to the user. | Add `onError` toasts (Radix toast already a dep). |
| M20 | Dashboard | `src/pages/PublicDeviceView.tsx:64-90` | Untrusted URL `serialNumber` (non-null `!`) flows to API; `refetchInterval:30s` polls a 404 forever. | Validate with Zod before enabling query; `retry:false`/disable interval on error. |
| M21 | Dashboard | `src/pages/DeviceDetail.tsx:365` | Notehub project UID **hardcoded** in source. | Move into `config.json` alongside `apiUrl`. |
| M22 | Dashboard | `src/App.tsx:131`, `Header.tsx:62`, `Map.tsx:97` | `AppLayout` passes `fleets={[]}` hardcoded → global fleet picker never renders; two divergent fleet sources. | Wire `useNotehubFleets()` into `AppLayout` or remove the dead plumbing. |
| M23 | Dashboard | `src/components/analytics/ChatMessage.tsx:99` | `<Markdown>` renders model-controlled text; safe today (no `rehype-raw`) but a latent stored-XSS vector if raw HTML is later enabled. | Keep HTML disabled; add guard-rail comment + URL-sanitizing `transformLinkUri`. |

### 🟢 Low

| # | Component | File:line | Issue | Recommended fix |
|---|---|---|---|---|
| L1 | Firmware | `SongbirdConfig.h`, `SongbirdSensors.cpp:35,255-285`, `SongbirdNotecard.cpp:96-112,901,943,1085`, `SongbirdTasks.cpp:47-52` | Magic numbers outside config.h (BME280 `0x76`; hysteresis `2.0/5.0/0.1`; hub.set `1/1440/15/10/60`; GPS `60`s; button sample/timeout constants). | Hoist into `SongbirdConfig.h`. |
| L2 | Firmware | `SongbirdAudio.cpp:155-163` | `audioPlayTone` releases I2C before `vTaskDelay` while buzzer sounds; concurrent reconfig could glitch audio. | Acceptable for demo; document, or hold across tone if glitching observed. |
| L3 | Firmware | `main.cpp:108-112,116-120` | `audioInit()`/`sensorsInit()` retry return value discarded on 2nd attempt. | Check retry result; set a degraded-mode flag. |
| L4 | Firmware | `SongbirdNotecard.cpp:1255-1266` | `notecardGetWakeReason()` is a **stub** — always reports timer wake, ignores motion/command. *(Orchestrator-flagged.)* | Read actual wake reason from Notecard state; correct callers relying on it. |
| L5 | Infra | `api-public-device/index.ts:142-145` | Maps `temperature:item.temp` / `voltage:item.voltage` but ingest writes `record.temperature` and never stores `voltage` on telemetry → always `undefined`. *(Live data-contract bug.)* | Read `item.temperature`; source voltage from `_log.qo`/device record. |
| L6 | Infra | `api-devices/index.ts:417-418`, `api-commands/index.ts:79` | `isAdmin` via `groups.includes('Admin')` — substring match on a possibly-string claim. | Normalize to array; exact membership. |
| L7 | Infra | `lib/auth-construct.ts:137-144` | Cognito OAuth callback/logout URLs only `localhost`; prod `songbird.live` absent. | Add prod URLs or document SPA uses SRP only. |
| L8 | Infra | `analytics-construct.ts:380,410,447,500`, `auth-construct.ts:217` | `bedrock:InvokeModel` on `resources:['*']` (4 lambdas) while `chatQueryLambda` is correctly scoped; PostConfirmation `cognito-idp:AdminAddUserToGroup` on `*`. *(Orchestrator-noted the SES/PostConf wildcards have mitigating context.)* | Scope Bedrock to FM ARNs; scope PostConfirmation to the user-pool ARN. |
| L9 | Dashboard | `DeviceDetail.tsx:491,105`, `Map.tsx:105,122`; `useTelemetry.ts:38-52`; `useAlerts.ts:17-68` | `(x as any)` casts defeat strict types (type drift w/ API); `useLatestTelemetry` is dead code; ack invalidates broad `['alerts']` → extra refetch of the 30s badge. | Add real fields to `src/types/`; remove dead hook; optionally scope invalidation. |

---

## (c) Cross-Component / Integration Risks

These are the end-to-end seams where two components must agree. Each was verified against **both** sides.

- **X1 — `health.qo` is emitted by firmware but dropped by ingest (High).** Firmware defines *and actively writes* app-level `health.qo` via `notecardSendHealthNote()` (`SongbirdNotecard.cpp:513`), including the **brownout/shutdown note** carrying reason+voltage (called from `SongbirdTasks.cpp:159,1031`). The ingest Lambda only branches on system **`_health.qo`** (`api-ingest/index.ts:210`), never app `health.qo`. Result: firmware health + shutdown events are received by Notehub, ingested, and **fall through with no handler → silently discarded**. The shutdown note goes nowhere. *(Orchestrator-confirmed on both sides; corroborated independently by firmware M1 and infra cross-cutting #1.)* **Fix:** either firmware emits to a file ingest handles, or add an ingest branch for app `health.qo` (distinguishing `shutdown` vs `firmware` keys).

- **X2 — `gps_power_saving` sent but not templated → never reaches cloud (High = H7).** Firmware note.add adds it (`SongbirdNotecard.cpp:414`) but it's absent from the compact template (`:203-212`); Notecard drops untemplated keys. Ingest expects it (`api-ingest/index.ts:258`). The GPS-power-save alert path is dead end-to-end.

- **X3 — System vs app notefile naming confusion (doc + contract).** CLAUDE.md (line ~68) lists `_track.qo`/`_geolocate.qo` as *firmware* outbound and `health.qo` (no underscore) as outbound. In reality: `_track.qo`/`_geolocate.qo`/`_health.qo`/`_log.qo`/`_session.qo` are **Notecard-generated** (firmware only *configures* them), and ingest correctly handles those. The doc's `health.qo` is the app file that ingest ignores (X1). **Fix:** correct CLAUDE.md and align the `health.qo` contract.

- **X4 — Command round-trip contract MATCHES (verified clean).** Cloud sends `command.qi` body `{cmd, params, command_id, sent_at}` (`api-commands/index.ts:255-260`); firmware reads `body.command_id` + `body.cmd` + `params.*` (`SongbirdNotecard.cpp:608,616,624-670`); firmware acks via `command_ack.qo` with key **`cmd_id`** (`:272`), which ingest reads as `body.cmd_id` (`:1081`). The inbound `command_id` → outbound `cmd_id` asymmetry is **consistent on both ends** — not a bug, but fragile; document it. Command **vocabulary matches exactly**: ping/locate/play_melody/test_audio/set_volume/unlock (firmware `SongbirdCommands.cpp:18-26` == infra `VALID_COMMANDS` `api-commands/index.ts:59`). **Doc drift (Low):** CLAUDE.md calls the unlock command `lock_override` — a name that exists nowhere in code.

- **X5 — `command_ack.qo.executed_at` is uptime, not epoch (M8).** Firmware sends `millis()/1000`; ingest stores it; dashboard must not render as wall-clock time. Contract needs a documented unit or a fix at the source.

- **X6 — Permission model consistency (ties C1/H1 to dashboard H3).** The dashboard gates **entirely client-side** on `cognito:groups` (`useAuth.ts:17-52`) — cosmetic only. Backend enforcement is therefore the sole control. `api-commands` does it right (`isAdmin`+`isDeviceOwner`, `:234-248`); **`api-config` does not (C1)** and ingest is unauthenticated (C2). Additionally the dashboard's `canSendCommands` returns **true for FieldEngineering** (only `Viewer`-only is false, `useAuth.ts:71`), but CLAUDE.md says FieldEngineering is read-only — **likely privilege bug**: confirm backend blocks FieldEngineering writes, else it's real escalation.

- **X7 — `sn` is a hard ingest dependency (High-impact coupling).** Ingest rejects *every* event lacking a non-empty `sn` with a 400 (`api-ingest/index.ts:139`) — which Notehub may retry indefinitely. Firmware/Notehub **must** set the serial number or all data (including health) is dropped. Single biggest firmware↔cloud coupling.

- **X8 — Mixed timestamp units (dashboard-facing).** Ingest stores telemetry `timestamp` in **ms** (`:446`) but `last_location.time` in **seconds** (`:968`); transforms ×1000 again (`api-devices/index.ts:328`, `api-public-device/index.ts:176`). Fragile; document as a shared contract.

- **X9 — Inconsistent error semantics end-to-end.** Ingest 500s on any failure (→ retry storms/dup writes); read APIs 500 with a generic envelope; `api-notehub` degrades to **200** with `health:'error'`. No uniform error envelope or correlation id; the dashboard can't distinguish "device offline" from "backend error." Adopt a shared error envelope + request id.

- **X10 — Field-name contract drift (already a live bug).** Public telemetry reads `temp`/`voltage` while ingest writes `temperature` and never stores `voltage` (L5). Also DynamoDB returns stringified booleans the dashboard must read as boolean-or-string (`Alerts.tsx:171`). A shared record-shape types module across ingest/read-APIs/dashboard would kill this class.

- **X11 — Two fleet sources of truth (dashboard-internal, M22).** Global `App.tsx` fleet state (dead/empty) vs `Map.tsx` `useNotehubFleets()`. Reconcile.

- **X12 — State persistence non-functional undermines any cloud logic assuming persisted lock/boot state (ties to C3/C4).** Anything downstream expecting locks or boot counts to survive sleep/brownout will observe resets.

---

## (d) Quick Wins (high value / low effort)

1. **Add the missing ESLint config** (H2) — restores the entire dashboard lint gate; ~15 min for a flat `eslint.config.js`.
2. **`.gitignore` `public/config.json` + `.env*`, rotate the Mapbox token** (H11) — trivial, closes a leak.
3. **`memset` the `Command` struct + null-terminate after `strncpy`** (H6) — a few lines, closes a cloud-reachable memory-safety bug.
4. **Enforce auth in `api-config`** by copy-pasting the `isAdmin`/`isDeviceOwner` pattern already proven in `api-commands` (C1) — highest security ROI in the repo.
5. **Redact `Authorization` before `console.log(event)`** across handlers (M15) — stops JWTs landing in CloudWatch.
6. **`JSON.stringify([ssid,password])`** instead of manual interpolation (M10) — one-line injection fix.
7. **Enable PITR on all stateful tables + `RETAIN` the alias table** (H10) — CDK one-liners, prevents catastrophic data loss.
8. **Drop the redundant demo-mode `hub.sync`** (M3) — saves battery/cellular immediately.
9. **Add the ingest `event`-id idempotency key** (H9) — one conditional write kills duplicate-telemetry inflation.
10. **Fix CLAUDE.md notefile/command doc drift** (X3, X4) — `lock_override`→`unlock`, clarify system vs app notefiles.
11. **Add `gps_power_saving` to the track template** (H7/X2) — one line, restores a dead feature end-to-end.

---

## (e) Areas NOT Assessed (and why)

- **On-hardware firmware behavior.** Builds succeeded (both envs, 0 warnings) but nothing was flashed/run. Stack high-water marks (M6), actual IWDG recovery (H3), real ATTN sleep/wake, and the C3/C4 persistence bugs are confirmed **by code inspection**, not runtime — on-device validation still needed.
- **Live AWS runtime + IAM effective permissions.** `cdk synth`/`diff` ran (diff saw only code-bundle hash changes vs the deployed stack), and 451 infra tests pass, but no requests were made against live Lambdas/DynamoDB. The auth Criticals (C1/C2) are proven by reading the handlers/routes, not by exploiting the deployed API. IAM findings are from CDK source, not from simulating effective policies.
- **Notehub-side configuration.** Whether Notehub actually sets `sn` (X7), routes to `/ingest`, and what notefiles the fleet emits in practice couldn't be observed — no Notehub project access in this review. The `health.qo` gap (X1) is proven from both codebases but its production frequency is unknown.
- **Analytics/RAG + Aurora subsystem** was reviewed at the handler level (H1, M16) but the Postgres schema, RLS posture, and the actual model-SQL sandbox behavior were not exercised — flagged as the highest-value follow-up attack surface.
- **Dashboard test/lint completeness.** `tsc --noEmit` passes clean; 394 vitest tests pass — **but** `node_modules` was only partially installed (the test runner had to be added `--no-save`) and lint never ran (no config), so "lint-clean" is unknown, not confirmed. Accessibility findings (L-tier) are from code inspection, not an axe/AT audit.
- **Performance/load.** Scan-heavy paths (M13) and re-render storms (M17) are identified structurally; no profiling or load testing was done to quantify the actual cliff.

---

*Report generated by orchestrated multi-agent review (3 domain agents + cross-component synthesis). Component detail preserved verbatim in the delegation summaries under `~/.hermes/cache/delegation/subagent-summary-{0,1,2}-*.txt`; cross-component trace staged in `review/.cross-component-notes.md`.*
