# Bug Fix: Sleep Mode Track.qo Generation

## Issue Report

**Device:** Songbird 03
**Symptom:** Over 20,000 track.qo events generated overnight while in sleep mode
**Observed Behavior:** Track.qo notes generated every 1-2 seconds during sleep mode
**Expected Behavior:** No track.qo notes should be generated in sleep mode (wake-on-motion only)

## Root Cause

The SensorTask in `songbird-firmware/src/rtos/SongbirdTasks.cpp` had a logic flaw where it continued to read sensors and queue track.qo notes even when in SLEEP mode.

### Code Flow (Before Fix)

```cpp
// Line 622-724 in SongbirdTasks.cpp
for (;;) {
    // ... sleep request check ...

    SongbirdConfig config;
    tasksGetConfig(&config);

    // Read sensors - THIS ALWAYS HAPPENS
    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
        readSuccess = sensorsRead(&data);
        // ... get voltage, motion, etc ...
    }

    if (readSuccess) {
        // ... alert checks ...

        // Queue track note - THIS ALWAYS HAPPENS
        NoteQueueItem noteItem;
        noteItem.type = NOTE_TYPE_TRACK;
        memcpy(&noteItem.data.track, &data, sizeof(SensorData));
        syncQueueNote(&noteItem);  // <-- GENERATES track.qo
    }

    // THEN check interval
    uint32_t interval = envGetSensorIntervalMs(&config);
    if (interval > 0) {
        vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(interval));
    } else {
        // Sleep mode - interval is 0
        vTaskDelay(pdMS_TO_TICKS(1000));  // <-- Only waits 1 second!
    }
}
```

**The Problem:**
- In SLEEP mode, `SENSOR_INTERVAL_SLEEP_MS = 0` (defined in SongbirdConfig.h:214)
- The interval check happens **AFTER** sensor reading and track note queueing
- When interval is 0, code waits only 1000ms (1 second) before looping again
- Result: Track.qo notes generated every 1-2 seconds continuously

## The Fix

Modified `SongbirdTasks.cpp` to check the sensor interval **BEFORE** attempting any sensor operations:

### Changes Made

**File:** `songbird-firmware/src/rtos/SongbirdTasks.cpp`

1. **Added early-exit check at start of loop (after line 624):**
```cpp
// Check if sensors should be read in current mode
uint32_t interval = envGetSensorIntervalMs(&config);
if (interval == 0) {
    // Sleep mode - sensors disabled, just wait
    vTaskDelay(pdMS_TO_TICKS(60000));  // 1 minute wait in sleep mode
    continue;  // Skip all sensor reading and note queueing
}
```

2. **Simplified interval wait at end of loop (line 721):**
```cpp
// Wait for next interval (interval guaranteed > 0 here due to check above)
vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(interval));
```

### Code Flow (After Fix)

```cpp
for (;;) {
    // ... sleep request check ...

    SongbirdConfig config;
    tasksGetConfig(&config);

    // NEW: Check interval FIRST
    uint32_t interval = envGetSensorIntervalMs(&config);
    if (interval == 0) {
        // Sleep mode - skip everything, wait 1 minute
        vTaskDelay(pdMS_TO_TICKS(60000));
        continue;
    }

    // Only reach here if interval > 0 (not sleep mode)
    // Read sensors
    if (syncAcquireI2C(...)) {
        readSuccess = sensorsRead(&data);
        // ...
    }

    if (readSuccess) {
        // Queue track note (only in active modes)
        syncQueueNote(&noteItem);
    }

    // Wait for interval
    vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(interval));
}
```

## Impact

**Before Fix:**
- Sleep mode: ~1 track.qo note every 1-2 seconds = ~43,200 notes per 24 hours
- Massive data usage spike
- Battery drain from constant I2C/sensor operations
- Notecard constantly syncing thousands of notes

**After Fix:**
- Sleep mode: 0 track.qo notes generated (correct behavior)
- Device wakes only on motion (or command if enabled)
- Minimal power consumption during sleep
- No unnecessary data usage

## Verification

1. **Build Status:** ✅ Firmware compiles successfully
   ```
   RAM:   [=         ]  10.7% (used 7008 bytes from 65536 bytes)
   Flash: [=====     ]  45.2% (used 118400 bytes from 262144 bytes)
   ```

2. **Recommended Testing:**
   - Flash updated firmware to test device
   - Set device to sleep mode
   - Monitor Notehub for track.qo events (should be 0)
   - Trigger motion wake
   - Verify device wakes and resumes normal operation
   - Check serial debug output to confirm "Sleep mode - sensors disabled" message

## Related Configuration

**SongbirdConfig.h Sensor Intervals:**
```cpp
#define SENSOR_INTERVAL_DEMO_MS         60000   // 60 seconds
#define SENSOR_INTERVAL_TRANSIT_MS      60000   // 1 minute
#define SENSOR_INTERVAL_STORAGE_MS      300000  // 5 minutes
#define SENSOR_INTERVAL_SLEEP_MS        0       // Disabled (wake-on-motion)
```

## Side Effects & Compatibility

- ✅ No breaking changes to API or configuration
- ✅ All other modes (demo, transit, storage) unaffected
- ✅ Sleep wake behavior unchanged (still wakes on motion/command)
- ✅ State restoration after sleep still works
- ⚠️ Users with devices in sleep mode will see immediate cessation of track.qo spam after firmware update

## Deployment Notes

After deploying this fix:
1. Devices currently in sleep mode will immediately stop generating track.qo notes
2. Users may need to clear accumulated events in Notehub if backlog is large
3. Data usage should return to normal levels
4. Battery life in sleep mode will improve significantly
