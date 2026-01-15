---
planStatus:
  planId: plan-gps-power-management-transit
  title: GPS Power Management in Transit Mode
  status: completed
  planType: feature
  priority: medium
  owner: developer
  tags:
    - firmware
    - gps
    - power-management
    - transit-mode
    - dashboard
    - infrastructure
  created: "2025-01-14"
  updated: "2025-01-15T19:15:00.000Z"
  progress: 100
---
# GPS Power Management in Transit Mode

## Goals
- Reduce battery consumption in Transit mode when GPS signal is unavailable
- Automatically disable GPS after a timeout period without satellite lock
- Periodically re-enable GPS to attempt signal acquisition
- Maintain full tracking capability when GPS signal is available
- Allow configuration of GPS power management settings via dashboard (device and fleet level)

## Overview

Currently, when a Songbird device enters Transit mode, GPS is enabled with a 60-second periodic interval and remains active regardless of whether a satellite signal can be obtained. This wastes battery power in scenarios where the device is in a location with poor GPS visibility (indoors, underground, dense urban canyons).

This feature introduces adaptive GPS power management that:
1. Monitors GPS signal acquisition status after entering Transit mode
2. Disables GPS if no lock is obtained after a configurable timeout (e.g., 3-5 minutes)
3. Periodically re-enables GPS to attempt signal acquisition (e.g., every 15-30 minutes)
4. Resumes normal GPS operation immediately once a lock is obtained

## Current Implementation Analysis

### GPS Configuration (SongbirdNotecard.cpp:833-875)
```cpp
bool notecardConfigureGPS(OperatingMode mode) {
    switch (mode) {
        case MODE_TRANSIT:
            // GPS enabled for tracking - 60 second interval
            JAddStringToObject(req, "mode", "periodic");
            JAddNumberToObject(req, "seconds", 60);
            break;
        // Other modes: GPS off
    }
}
```

### GPS Status Monitoring (SongbirdTasks.cpp)
The NotecardTask already monitors GPS status via `notecardGetGPSStatus()` every 5 seconds and calls `stateUpdateGpsFixTime()` when a fresh fix is acquired.

### State Tracking (SongbirdState.h)
The `SongbirdState` structure already tracks `lastGpsFixTime` which can be leveraged for timeout detection.

### Key Files
- `songbird-firmware/src/notecard/SongbirdNotecard.cpp` - GPS configuration functions
- `songbird-firmware/src/notecard/SongbirdNotecard.h` - GPS API declarations
- `songbird-firmware/src/rtos/SongbirdTasks.cpp` - GPS monitoring task
- `songbird-firmware/src/core/SongbirdState.h` - State persistence structure
- `songbird-firmware/src/core/SongbirdConfig.h` - Configuration constants

## Implementation Details

### 1. Add GPS Power Management State

**File:** `songbird-firmware/src/core/SongbirdState.h`

Add new fields to `SongbirdState` structure:
```cpp
typedef struct {
    // ... existing fields ...

    // GPS power management
    bool gpsPowerSaving;           // GPS is currently disabled for power saving
    uint32_t gpsSearchStartTime;   // When current GPS search attempt began
    uint32_t lastGpsRetryTime;     // When last GPS retry occurred

    // ... reserved fields ...
} SongbirdState;
```

### 2. Add Configuration Constants

**File:** `songbird-firmware/src/core/SongbirdConfig.h`

Add configurable timeout values:
```cpp
// GPS Power Management (Transit Mode)
#define GPS_LOCK_TIMEOUT_MS         180000  // 3 minutes to acquire lock
#define GPS_RETRY_INTERVAL_MS       1800000 // 30 minutes between retry attempts
#define GPS_RETRY_DURATION_MS       180000  // 3 minutes to attempt lock on retry
```

### 3. Implement GPS Power Control Functions

**File:** `songbird-firmware/src/notecard/SongbirdNotecard.cpp`

Add new functions:
```cpp
/**
 * @brief Disable GPS to save power (while remaining in transit mode)
 * @return true if GPS disabled successfully
 */
bool notecardDisableGPS(void);

/**
 * @brief Re-enable GPS for transit mode tracking
 * @return true if GPS enabled successfully
 */
bool notecardEnableTransitGPS(void);
```

Implementation:
```cpp
bool notecardDisableGPS(void) {
    J* req = s_notecard.newRequest("card.location.mode");
    JAddStringToObject(req, "mode", "off");
    // ... execute and return result
}

bool notecardEnableTransitGPS(void) {
    J* req = s_notecard.newRequest("card.location.mode");
    JAddStringToObject(req, "mode", "periodic");
    JAddNumberToObject(req, "seconds", 60);
    // ... execute and return result
}
```

### 4. Add State Management Functions

**File:** `songbird-firmware/src/core/SongbirdState.cpp`

Add helper functions:
```cpp
void stateSetGpsPowerSaving(bool enabled);
bool stateIsGpsPowerSaving(void);
void stateUpdateGpsSearchStartTime(void);
uint32_t stateGetGpsSearchStartTime(void);
void stateUpdateGpsRetryTime(void);
uint32_t stateGetLastGpsRetryTime(void);
```

### 5. Implement GPS Power Management Logic

**File:** `songbird-firmware/src/rtos/SongbirdTasks.cpp`

Modify the NotecardTask GPS monitoring section:

```cpp
// GPS power management for Transit mode
if (config.mode == MODE_TRANSIT) {
    bool hasLock;
    notecardGetGPSStatus(&hasLock, NULL, NULL, NULL);

    SongbirdState* state = stateGet();

    if (state->gpsPowerSaving) {
        // Currently in power-saving mode (GPS disabled)
        uint32_t timeSinceRetry = millis() - state->lastGpsRetryTime;

        if (timeSinceRetry >= GPS_RETRY_INTERVAL_MS) {
            // Time to retry GPS acquisition
            DEBUG_SERIAL.println("[GPS] Retrying GPS acquisition");
            notecardEnableTransitGPS();
            stateSetGpsPowerSaving(false);
            stateUpdateGpsSearchStartTime();
        }
    } else {
        // GPS is active
        if (hasLock) {
            // We have a lock - update search start time (reset timeout)
            stateUpdateGpsSearchStartTime();
        } else {
            // No lock - check if timeout exceeded
            uint32_t searchDuration = millis() - state->gpsSearchStartTime;

            if (searchDuration >= GPS_LOCK_TIMEOUT_MS) {
                // Timeout reached, disable GPS to save power
                DEBUG_SERIAL.println("[GPS] No lock after timeout, entering power-save");
                notecardDisableGPS();
                stateSetGpsPowerSaving(true);
                stateUpdateGpsRetryTime();
            }
        }
    }
}
```

### 6. Handle Mode Transitions

**File:** `songbird-firmware/src/rtos/SongbirdTasks.cpp`

When entering Transit mode, initialize GPS power management state:
```cpp
// In MainTask, when mode changes to TRANSIT:
if (newConfig.mode == MODE_TRANSIT) {
    stateSetGpsPowerSaving(false);  // Start with GPS enabled
    stateUpdateGpsSearchStartTime();
}
```

When leaving Transit mode, ensure state is reset:
```cpp
// When leaving TRANSIT mode:
if (oldMode == MODE_TRANSIT && newConfig.mode != MODE_TRANSIT) {
    stateSetGpsPowerSaving(false);  // Reset power-saving state
}
```

### 7. Location Fallback

While GPS is disabled for power saving, the device should continue to use triangulation (which is always enabled) to provide approximate location data. This is already configured via `notecardConfigureTriangulation()` at startup, so no changes are needed.

## State Machine

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRANSIT MODE                                  │
│                                                                      │
│  ┌─────────────┐     No lock after      ┌─────────────────────┐    │
│  │             │     GPS_LOCK_TIMEOUT   │                     │    │
│  │ GPS Active  │ ────────────────────▶  │ GPS Power Saving    │    │
│  │             │                        │ (GPS disabled)      │    │
│  │             │ ◀────────────────────  │                     │    │
│  └─────────────┘     GPS_RETRY_INTERVAL └─────────────────────┘    │
│        │               elapsed                   │                  │
│        │                                         │                  │
│        │ Lock acquired                           │                  │
│        ▼ (reset timeout)                         │                  │
│  ┌─────────────┐                                 │                  │
│  │ GPS Active  │                                 │                  │
│  │ (tracking)  │                                 │                  │
│  └─────────────┘                                 │                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: Environment Variable Configuration

### New Environment Variables

Add the following Notehub environment variables for GPS power management:

| Variable | Type | Range | Default | Description |
| --- | --- | --- | --- | --- |
| `gps_power_save_enabled` | boolean | true/false | true | Enable/disable GPS power saving in transit mode |
| `gps_lock_timeout_min` | number | 1-30 | 3 | Minutes to wait for GPS lock before power-save |
| `gps_retry_interval_min` | number | 5-120 | 30 | Minutes between GPS retry attempts |

### Firmware: Read Environment Variables

**File:** `songbird-firmware/src/commands/SongbirdEnv.cpp`

Add parsing for new environment variables:
```cpp
// In envReadFromNotecard() or equivalent
config->gpsPowerSaveEnabled = notecardEnvGetBool("gps_power_save_enabled", true);
config->gpsLockTimeoutMin = notecardEnvGetInt("gps_lock_timeout_min", 3);
config->gpsRetryIntervalMin = notecardEnvGetInt("gps_retry_interval_min", 30);
```

**File:** `songbird-firmware/src/core/SongbirdConfig.h`

Add to SongbirdConfig structure:
```cpp
typedef struct {
    // ... existing fields ...

    // GPS Power Management
    bool gpsPowerSaveEnabled;      // Enable GPS power saving in transit
    uint8_t gpsLockTimeoutMin;     // Minutes to wait for GPS lock
    uint8_t gpsRetryIntervalMin;   // Minutes between retry attempts
} SongbirdConfig;
```

---

## Part 3: Infrastructure Changes

### 3.1 Update Config Schema

**File:** `songbird-infrastructure/lambda/api-config/index.ts`

Add to `CONFIG_SCHEMA`:
```typescript
const CONFIG_SCHEMA = {
  // ... existing fields ...

  // GPS Power Management
  gps_power_save_enabled: { type: 'boolean' },
  gps_lock_timeout_min: { type: 'number', min: 1, max: 30 },
  gps_retry_interval_min: { type: 'number', min: 5, max: 120 },
};
```

### 3.2 Update Settings Schema

**File:** `songbird-infrastructure/lambda/api-settings/index.ts`

Add to `FLEET_DEFAULTS_SCHEMA`:
```typescript
const FLEET_DEFAULTS_SCHEMA = {
  // ... existing fields ...

  // GPS Power Management
  gps_power_save_enabled: { type: 'boolean' },
  gps_lock_timeout_min: { type: 'number', min: 1, max: 30 },
  gps_retry_interval_min: { type: 'number', min: 5, max: 120 },
};
```

---

## Part 4: Dashboard Changes

### 4.1 Update Type Definitions

**File:** `songbird-dashboard/src/types/index.ts`

Add to `DeviceConfig` interface:
```typescript
export interface DeviceConfig {
  // ... existing fields ...

  // GPS Power Management
  gps_power_save_enabled?: boolean;
  gps_lock_timeout_min?: number;
  gps_retry_interval_min?: number;
}
```

Add to `FleetDefaults` interface:
```typescript
export interface FleetDefaults {
  // ... existing fields ...

  // GPS Power Management
  gps_power_save_enabled?: boolean;
  gps_lock_timeout_min?: number;
  gps_retry_interval_min?: number;
}
```

### 4.2 Update Fleet Defaults UI

**File:** `songbird-dashboard/src/components/settings/FleetDefaults.tsx`

Add GPS Power Management section after the existing Transit mode settings:

```tsx
{/* GPS Power Management Section */}
<div className="space-y-4">
  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2">
    <Satellite className="h-4 w-4" />
    GPS Power Management (Transit Mode)
  </h4>

  {/* Enable/Disable Toggle */}
  <div className="flex items-center justify-between">
    <div>
      <Label htmlFor="gps-power-save">GPS Power Saving</Label>
      <p className="text-xs text-muted-foreground">
        Disable GPS when signal unavailable to save battery
      </p>
    </div>
    <Switch
      id="gps-power-save"
      checked={config.gps_power_save_enabled ?? true}
      onCheckedChange={(checked) =>
        setConfig({ ...config, gps_power_save_enabled: checked })
      }
    />
  </div>

  {/* Lock Timeout Slider */}
  {config.gps_power_save_enabled && (
    <>
      <div className="space-y-2">
        <div className="flex justify-between">
          <Label>GPS Lock Timeout</Label>
          <span className="text-sm text-muted-foreground">
            {config.gps_lock_timeout_min ?? 3} minutes
          </span>
        </div>
        <Slider
          value={[config.gps_lock_timeout_min ?? 3]}
          onValueChange={([value]) =>
            setConfig({ ...config, gps_lock_timeout_min: value })
          }
          min={1}
          max={30}
          step={1}
        />
        <p className="text-xs text-muted-foreground">
          Time to wait for GPS signal before disabling
        </p>
      </div>

      {/* Retry Interval Slider */}
      <div className="space-y-2">
        <div className="flex justify-between">
          <Label>GPS Retry Interval</Label>
          <span className="text-sm text-muted-foreground">
            {config.gps_retry_interval_min ?? 30} minutes
          </span>
        </div>
        <Slider
          value={[config.gps_retry_interval_min ?? 30]}
          onValueChange={([value]) =>
            setConfig({ ...config, gps_retry_interval_min: value })
          }
          min={5}
          max={120}
          step={5}
        />
        <p className="text-xs text-muted-foreground">
          How often to retry GPS acquisition when in power-save mode
        </p>
      </div>
    </>
  )}
</div>
```

### 4.3 Update Device Config Panel

**File:** `songbird-dashboard/src/components/config/ConfigPanel.tsx`

Add the same GPS Power Management controls to the device-level configuration panel, allowing per-device overrides of fleet defaults.

---

## Part 5: Telemetry Reporting (Optional Enhancement)

### Include GPS Power State in Track Notes

**File:** `songbird-firmware/src/notecard/SongbirdNotecard.cpp`

Modify `notecardSendTrackNote()` to include GPS power state:
```cpp
if (mode == MODE_TRANSIT) {
    SongbirdState* state = stateGet();
    JAddBoolToObject(body, "gps_power_save", state->gpsPowerSaving);
}
```

### Dashboard: Show GPS Power State

**File:** `songbird-dashboard/src/components/device/DeviceStatus.tsx`

Display GPS power state indicator when device is in transit mode and GPS is in power-save mode.

---

## Updated Acceptance Criteria

### Firmware
- [ ] GPS is automatically disabled after configurable timeout without acquiring a lock
- [ ] GPS is re-enabled at configurable intervals to attempt signal acquisition
- [ ] GPS resumes normal operation immediately upon acquiring a lock
- [ ] State persists across sleep/wake cycles
- [ ] Mode transitions properly initialize/reset GPS power management state
- [ ] Device continues to report location via triangulation when GPS is disabled
- [ ] Debug logs indicate GPS power state transitions
- [ ] No regression in GPS tracking when signal is available
- [ ] Firmware reads and applies `gps_power_save_enabled`, `gps_lock_timeout_min`, `gps_retry_interval_min` from environment variables

### Infrastructure
- [ ] Config Lambda validates new GPS power management fields
- [ ] Settings Lambda validates new GPS power management fields
- [ ] Environment variables are pushed to Notehub correctly

### Dashboard
- [ ] Fleet Defaults page includes GPS Power Management section
- [ ] Device Config Panel includes GPS Power Management section
- [ ] Toggle to enable/disable GPS power saving
- [ ] Slider for lock timeout (1-30 minutes)
- [ ] Slider for retry interval (5-120 minutes)
- [ ] Settings conditionally show (sliders hidden when power save disabled)
- [ ] Values persist and sync with Notehub

---

## Testing Plan

### Firmware Testing
1. **Indoor test**: Place device in Transit mode indoors, verify GPS disables after timeout
2. **Outdoor recovery**: Move device outdoors during retry window, verify GPS lock and normal operation
3. **Mode transition**: Test switching between modes resets GPS power state correctly
4. **Sleep/wake**: Verify GPS power state persists correctly across sleep cycles
5. **Power measurement**: Compare battery consumption with/without feature enabled
6. **Config sync**: Verify device applies new timeout/interval values from Notehub

### Dashboard Testing
1. **Fleet defaults**: Update GPS power settings at fleet level, verify all devices in fleet receive update
2. **Device override**: Set different GPS power settings for individual device, verify device-level takes precedence
3. **Validation**: Test min/max bounds on sliders
4. **UI state**: Toggle power save off, verify sliders are hidden
5. **Persistence**: Save settings, refresh page, verify values persist

---

## Files to Modify

### Firmware
1. `songbird-firmware/src/core/SongbirdConfig.h` - Add timeout constants and config fields
2. `songbird-firmware/src/core/SongbirdState.h` - Add GPS power state fields
3. `songbird-firmware/src/core/SongbirdState.cpp` - Add state management functions
4. `songbird-firmware/src/notecard/SongbirdNotecard.h` - Declare new GPS functions
5. `songbird-firmware/src/notecard/SongbirdNotecard.cpp` - Implement GPS enable/disable
6. `songbird-firmware/src/rtos/SongbirdTasks.cpp` - GPS power management logic
7. `songbird-firmware/src/commands/SongbirdEnv.cpp` - Read new env vars

### Infrastructure
8. `songbird-infrastructure/lambda/api-config/index.ts` - Add to CONFIG_SCHEMA
9. `songbird-infrastructure/lambda/api-settings/index.ts` - Add to FLEET_DEFAULTS_SCHEMA

### Dashboard
10. `songbird-dashboard/src/types/index.ts` - Update DeviceConfig and FleetDefaults interfaces
11. `songbird-dashboard/src/components/settings/FleetDefaults.tsx` - Add GPS Power Management UI
12. `songbird-dashboard/src/components/config/ConfigPanel.tsx` - Add GPS Power Management UI

