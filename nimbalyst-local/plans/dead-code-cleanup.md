---
planStatus:
  planId: plan-dead-code-cleanup
  title: Dead Code and Unused Code Cleanup
  status: ready-for-development
  planType: refactor
  priority: high
  owner: developer
  tags:
    - cleanup
    - refactor
    - firmware
    - infrastructure
    - dashboard
  created: "2026-01-17"
  updated: "2026-01-17T12:00:00.000Z"
  progress: 0
---
# Dead Code and Unused Code Cleanup

## Goals
- Remove all unused functions, imports, and code paths
- Fix critical stub implementations in firmware
- Address security concerns (hardcoded tokens)
- Consolidate duplicate code
- Improve overall code quality and maintainability

## Overview

A comprehensive audit of the Songbird codebase revealed dead code, unused functions, broken stub implementations, and security issues across all three components (firmware, infrastructure, dashboard). This plan addresses each finding systematically.

---

## Phase 1: Critical Firmware Fixes (PRIORITY: CRITICAL)

These stub implementations are breaking sleep/wake functionality and must be fixed first.

### 1.1 Fix `notecardGetWakeReason()` stub (UNUSED)
- **File**: `songbird-firmware/src/notecard/SongbirdNotecard.cpp:1205-1216`
- **Issue**: Stub that always returns "timer wake" - but function is never called
- **Decision**: Remove entirely OR implement if sleep/wake feature is needed

### 1.2 Fix `notecardGetSleepPayload()` stub (USED BUT BROKEN)
- **File**: `songbird-firmware/src/notecard/SongbirdNotecard.cpp:1218-1224`
- **Issue**: Returns hardcoded 0 - called by `stateRestore()` in SongbirdState.cpp:90
- **Fix**: Implement proper payload retrieval from Notecard sleep state

### 1.3 Fix `notecardConfigureSleep()` payload encoding (USED BUT BROKEN)
- **File**: `songbird-firmware/src/notecard/SongbirdNotecard.cpp:1173-1178`
- **Issue**: Binary `SongbirdState` cast directly to string without base64 encoding - called by `stateSave()` in SongbirdState.cpp:161
- **Fix**: Add proper base64 encoding for binary payload data

### Acceptance Criteria - Phase 1
- [ ] `notecardGetWakeReason()` removed or properly implemented
- [ ] `notecardGetSleepPayload()` retrieves persisted state correctly
- [ ] `notecardConfigureSleep()` properly base64 encodes payload
- [ ] Sleep/wake cycle tested and working on device

---

## ~~Phase 2: Firmware Runtime Fixes~~ - MOSTLY FALSE POSITIVES

### ~~2.1 Fix ~~~~`vTaskDelay()`~~~~ calls before scheduler starts~~ - FALSE POSITIVE
- **File**: `songbird-firmware/src/audio/SongbirdAudio.cpp`
- **Status**: Code already has proper scheduler state checking via `useRtosPrimitives()` (line 85-89)
- **`audioToggleMute()`**: Only called from MainTask after scheduler starts
- **`audioPlayTone()`**: Uses `useRtosPrimitives()` to conditionally use `delay()` vs `vTaskDelay()`
- **Action**: None needed

### 2.1a Minor: `audioPlayMelody()` line 199 (OPTIONAL)
- **File**: `songbird-firmware/src/audio/SongbirdAudio.cpp:199`
- **Issue**: Line 199 calls `vTaskDelay()` without checking scheduler state
- **Risk**: Very low - pre-scheduler calls only happen in fatal error paths that immediately exit
- **Optional Fix**: Add `useRtosPrimitives()` check for extra safety

### ~~2.2 Remove duplicate ~~~~`vTaskDelay()`~~~~ in buzzer timing~~ - FALSE POSITIVE
- **File**: `songbird-firmware/src/audio/SongbirdAudio.cpp:156-161`
- **Status**: This is an intentional `if/else` structure, not a duplicate
  - `if (useRtos)`: Release mutex + vTaskDelay (allows other tasks during tone)
  - `else`: blocking delay() for pre-scheduler context
- **Action**: None needed

---

## Phase 3: Firmware Unused Code Removal (PRIORITY: MEDIUM)

### 3.1 Remove unused sensor functions
- **File**: `songbird-firmware/src/sensors/SongbirdSensors.cpp`
- **Functions to remove**:
  - `sensorsReadTemperature()` (lines 138-149)
  - `sensorsReadHumidity()` (lines 151-162)
  - `sensorsReadPressure()` (lines 164-175)
  - `sensorsGetErrorCount()` (lines 177-179)
  - `sensorsResetErrorCount()` (lines 181-183)

### 3.2 Remove unused command functions
- **File**: `songbird-firmware/src/commands/SongbirdCommands.cpp`
- **Functions to remove**:
  - `commandsParseType()` (lines 103-115) - truly unused
- **Functions to KEEP**:
  - ~~`commandsGetTypeName()`~~ - USED for debug logging in `commandsExecute()` line 64

### ~~3.3 Remove unused configuration options~~ - FALSE POSITIVE
- **File**: `songbird-firmware/src/core/SongbirdConfig.h`
- **Status**: BOTH ARE ACTIVELY USED in SongbirdEnv.cpp
  - ~~`DEFAULT_LED_ENABLED`~~~~ / ~~~~`ledEnabled`~~ - Used at lines 45, 185, 252, 477, 625-629
  - ~~`DEFAULT_DEBUG_MODE`~~~~ / ~~~~`debugMode`~~ - Used at lines 46, 190, 253, 477, 631-635
- **Action**: None needed

### Acceptance Criteria - Phase 3
- [ ] All unused sensor functions removed (5 functions)
- [ ] Unused command function removed (1 function: `commandsParseType`)
- [ ] Firmware compiles and runs correctly

---

## Phase 4: Infrastructure Security Fix (PRIORITY: HIGH)

### 4.1 Remove hardcoded Mapbox token
- **File**: `songbird-infrastructure/lib/api-construct.ts:354`
- **Issue**: Mapbox API token is hardcoded in source code
- **Fix**: Use the `MapboxSecret` that's already created (lines 334-337) instead of hardcoded value

### Acceptance Criteria - Phase 4
- [ ] Mapbox token stored in AWS Secrets Manager
- [ ] Lambda reads token from secret, not hardcode
- [ ] No API tokens in source code

---

## Phase 5: Infrastructure Code Cleanup (PRIORITY: MEDIUM)

### ~~5.1 Remove unused ~~~~`ACTIVITY_TABLE`~~~~ variable~~ - FALSE POSITIVE
- **File**: `songbird-infrastructure/lambda/api-devices/index.ts:28`
- **Status**: USED - called in `mergeDevices()` function on line 500
- **Action**: None needed

### 5.2 Remove duplicate `getAllDeviceUidsForSerial()` function
- **File**: `songbird-infrastructure/lambda/api-alerts/index.ts:29-45`
- **Issue**: Duplicates logic already in `lambda/shared/device-lookup.ts:125-136`
- **Fix**: Import from shared module instead of local implementation

### 5.3 Remove unused imports
- **File**: `songbird-infrastructure/lambda/api-journeys/index.ts:16`
  - Remove unused `APIGatewayProxyEventV2`
- **File**: `songbird-infrastructure/lambda/api-public-device/index.ts:12-16`
  - ~~Remove unused ~~~~`DeleteCommand`~~ - FALSE POSITIVE: DeleteCommand is not imported in this file

### Acceptance Criteria - Phase 5
- [ ] Duplicate `getAllDeviceUidsForSerial()` replaced with shared module import
- [ ] Unused `APIGatewayProxyEventV2` import removed
- [ ] Infrastructure deploys successfully

---

## Phase 6: Dashboard Code Cleanup (PRIORITY: MEDIUM)

### 6.1 Remove unused formatter functions
- **File**: `songbird-dashboard/src/utils/formatters.ts`
- **Functions to remove**:
  - `formatDate()` (line 18)
  - `formatTime()` (line 26)
  - `formatDateTime()` (line 34)
  - `formatSignal()` (line 131)
  - `formatCoordinates()` (line 122)

### 6.2 Remove or internalize unused `sendCommand()` API
- **File**: `songbird-dashboard/src/api/commands.ts:36-45`
- **Fix**: Either remove export keyword (make internal) or remove entirely if truly unused

### 6.3 Consolidate duplicate `celsiusToFahrenheit()` implementations
- **Files affected**:
  - `songbird-dashboard/src/components/settings/FleetDefaults.tsx`
  - `songbird-dashboard/src/components/config/ConfigPanel.tsx`
- **Fix**: Remove local implementations, import from `src/utils/formatters.ts`

### 6.4 Remove or implement dark mode CSS
- **File**: `songbird-dashboard/src/index.css:29-49`
- **Issue**: `.dark` theme CSS defined but never used
- **Fix**: Either remove the CSS or implement dark mode toggle

### Acceptance Criteria - Phase 6
- [ ] All unused formatters removed
- [ ] No duplicate utility implementations
- [ ] Dashboard builds and runs correctly
- [ ] Decision made on dark mode (implement or remove)

---

## Implementation Order

1. **Phase 1** - Critical firmware fixes (sleep/wake broken)
2. **Phase 4** - Security fix (hardcoded token)
3. **Phase 2** - Firmware runtime fixes
4. **Phase 3** - Firmware cleanup
5. **Phase 5** - Infrastructure cleanup
6. **Phase 6** - Dashboard cleanup

---

## Summary (Final Verification Complete)

| Phase | Priority | Component | Verified Items | False Positives |
| --- | --- | --- | --- | --- |
| 1 | CRITICAL | Firmware | 3 (1 unused stub to remove, 2 broken stubs to fix) | 0 |
| 2 | ~~HIGH~~ | ~~Firmware~~ | ~~0~~ | 2 (scheduler checks already exist) |
| 3 | MEDIUM | Firmware | 6 (5 sensor funcs + 1 command func) | 3 (`commandsGetTypeName`, `ledEnabled`, `debugMode` all used) |
| 4 | HIGH | Infrastructure | 1 security fix | 0 |
| 5 | MEDIUM | Infrastructure | 2 cleanup items | 2 (`ACTIVITY_TABLE` used, `DeleteCommand` not imported) |
| 6 | MEDIUM | Dashboard | 4 cleanup items | 0 |

**Total verified items**: 16 actual fixes across 5 phases (9 false positives removed)

### Final Count by Component
- **Firmware**: 1 unused stub removal + 2 broken stub fixes + 6 unused function removals = **9 items**
- **Infrastructure**: 1 security fix + 2 cleanups = **3 items**
- **Dashboard**: 4 cleanups = **4 items**

### Verified Unused Functions (Safe to Remove)
| Component | Function | File |
| --- | --- | --- |
| Firmware | `notecardGetWakeReason()` | SongbirdNotecard.cpp:1205 |
| Firmware | `sensorsReadTemperature()` | SongbirdSensors.cpp:138 |
| Firmware | `sensorsReadHumidity()` | SongbirdSensors.cpp:151 |
| Firmware | `sensorsReadPressure()` | SongbirdSensors.cpp:164 |
| Firmware | `sensorsGetErrorCount()` | SongbirdSensors.cpp:177 |
| Firmware | `sensorsResetErrorCount()` | SongbirdSensors.cpp:181 |
| Firmware | `commandsParseType()` | SongbirdCommands.cpp:102 |
| Dashboard | `formatDate()` | formatters.ts:18 |
| Dashboard | `formatTime()` | formatters.ts:26 |
| Dashboard | `formatDateTime()` | formatters.ts:34 |
| Dashboard | `formatSignal()` | formatters.ts:131 |
| Dashboard | `formatCoordinates()` | formatters.ts:122 |
