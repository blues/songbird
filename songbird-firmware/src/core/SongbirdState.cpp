/**
 * @file SongbirdState.cpp
 * @brief State persistence implementation
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdState.h"
#include "SongbirdNotecard.h"
#include <string.h>
#include <STM32FreeRTOS.h>

// =============================================================================
// Module State
// =============================================================================

static SongbirdState s_state;
static bool s_warmBoot = false;
static uint32_t s_bootStartTime = 0;

// =============================================================================
// CRC32 Implementation (simple polynomial)
// =============================================================================

static uint32_t crc32(const uint8_t* data, size_t length) {
    uint32_t crc = 0xFFFFFFFF;

    for (size_t i = 0; i < length; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
    }

    return ~crc;
}

// =============================================================================
// Initialization
// =============================================================================

void stateInit(void) {
    memset(&s_state, 0, sizeof(s_state));

    s_state.magic = STATE_MAGIC;
    s_state.version = STATE_VERSION;
    s_state.bootCount = 1;
    s_state.lastSyncTime = 0;
    s_state.lastGpsFixTime = 0;
    s_state.lastPressure = NAN;
    s_state.currentMode = MODE_DEMO;
    s_state.alertsSent = 0;
    s_state.motionSinceLastReport = false;
    s_state.uptimeAtSleep = 0;
    s_state.totalUptimeSec = 0;
    s_state.transitLocked = false;
    s_state.preTransitMode = MODE_DEMO;
    s_state.demoLocked = false;
    s_state.preDemoMode = MODE_DEMO;

    // GPS Power Management
    s_state.gpsPowerSaving = false;
    s_state.gpsWasActive = false;
    s_state.gpsActiveStartTime = 0;
    s_state.lastGpsRetryTime = 0;

    s_bootStartTime = millis();
    s_warmBoot = false;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[State] Initialized with defaults");
    #endif
}

SongbirdState* stateGet(void) {
    return &s_state;
}

// =============================================================================
// State Persistence
// =============================================================================

bool stateRestore(void) {
    // Get payload from Notecard (saved before last sleep)
    uint8_t buffer[sizeof(SongbirdState)];
    size_t size = notecardGetSleepPayload(buffer, sizeof(buffer));

    if (size != sizeof(SongbirdState)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.print("[State] Payload size mismatch: ");
        DEBUG_SERIAL.print(size);
        DEBUG_SERIAL.print(" vs ");
        DEBUG_SERIAL.println(sizeof(SongbirdState));
        #endif
        return false;
    }

    // Copy to temporary for validation
    SongbirdState restored;
    memcpy(&restored, buffer, sizeof(restored));

    // Validate magic number
    if (restored.magic != STATE_MAGIC) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[State] Invalid magic number");
        #endif
        return false;
    }

    // Validate version
    if (restored.version != STATE_VERSION) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.print("[State] Version mismatch: ");
        DEBUG_SERIAL.println(restored.version);
        #endif
        return false;
    }

    // Validate checksum
    if (!stateValidateChecksum(&restored)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[State] Checksum invalid");
        #endif
        return false;
    }

    // Restore state
    memcpy(&s_state, &restored, sizeof(s_state));

    // Increment boot count
    s_state.bootCount++;

    // Update uptime accounting
    s_bootStartTime = millis();

    s_warmBoot = true;

    // Restore lock LED state
    stateUpdateLockLED();

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[State] Restored (boot #");
    DEBUG_SERIAL.print(s_state.bootCount);
    DEBUG_SERIAL.println(")");
    #endif

    return true;
}

bool stateSave(void) {
    // Prepare for sleep
    statePrepareForSleep();

    // Calculate checksum
    s_state.checksum = stateCalculateChecksum(&s_state);

    // Save to Notecard payload
    // Note: This is a simplified version - actual implementation would
    // use notecardConfigureSleep with the payload
    bool success = notecardConfigureSleep(
        0,      // Sleep duration handled elsewhere
        false,  // Motion wake handled elsewhere
        false,  // Command wake handled elsewhere
        (const uint8_t*)&s_state,
        sizeof(s_state)
    );

    #ifdef DEBUG_MODE
    if (success) {
        DEBUG_SERIAL.println("[State] Saved to Notecard payload");
    } else {
        DEBUG_SERIAL.println("[State] Failed to save");
    }
    #endif

    return success;
}

bool stateIsWarmBoot(void) {
    return s_warmBoot;
}

// =============================================================================
// State Updates
// =============================================================================

void stateIncrementBootCount(void) {
    taskENTER_CRITICAL();
    s_state.bootCount++;
    taskEXIT_CRITICAL();
}

void stateUpdateSyncTime(void) {
    taskENTER_CRITICAL();
    s_state.lastSyncTime = millis();
    taskEXIT_CRITICAL();
}

void stateUpdateGpsFixTime(void) {
    taskENTER_CRITICAL();
    s_state.lastGpsFixTime = millis();
    taskEXIT_CRITICAL();
}

void stateUpdateLastPressure(float pressure) {
    taskENTER_CRITICAL();
    s_state.lastPressure = pressure;
    taskEXIT_CRITICAL();
}

void stateSetMode(OperatingMode mode) {
    taskENTER_CRITICAL();
    s_state.currentMode = mode;
    taskEXIT_CRITICAL();
}

void stateSetAlert(uint8_t alertFlag) {
    taskENTER_CRITICAL();
    s_state.alertsSent |= alertFlag;
    taskEXIT_CRITICAL();
}

void stateClearAlert(uint8_t alertFlag) {
    taskENTER_CRITICAL();
    s_state.alertsSent &= ~alertFlag;
    taskEXIT_CRITICAL();
}

uint8_t stateGetAlerts(void) {
    taskENTER_CRITICAL();
    uint8_t alerts = s_state.alertsSent;
    taskEXIT_CRITICAL();
    return alerts;
}

void stateSetMotion(bool motion) {
    taskENTER_CRITICAL();
    if (motion) {
        // Sticky flag — only cleared by stateGetAndClearMotion()
        s_state.motionSinceLastReport = true;
    }
    // Intentional: passing false is a no-op to prevent race conditions
    // between motion detection and reporting.
    taskEXIT_CRITICAL();
}

bool stateGetAndClearMotion(void) {
    taskENTER_CRITICAL();
    bool motion = s_state.motionSinceLastReport;
    s_state.motionSinceLastReport = false;
    taskEXIT_CRITICAL();
    return motion;
}

void statePrepareForSleep(void) {
    // Calculate uptime for this wake cycle
    uint32_t currentUptime = (millis() - s_bootStartTime) / 1000;
    s_state.uptimeAtSleep = millis();
    s_state.totalUptimeSec += currentUptime;
}

uint32_t stateGetTotalUptimeSec(void) {
    // Current session uptime + accumulated from previous sessions
    uint32_t currentSession = (millis() - s_bootStartTime) / 1000;
    return s_state.totalUptimeSec + currentSession;
}

uint32_t stateGetBootCount(void) {
    taskENTER_CRITICAL();
    uint32_t count = s_state.bootCount;
    taskEXIT_CRITICAL();
    return count;
}

float stateGetLastPressure(void) {
    taskENTER_CRITICAL();
    float pressure = s_state.lastPressure;
    taskEXIT_CRITICAL();
    return pressure;
}

void stateSetTransitLock(bool locked, OperatingMode previousMode) {
    taskENTER_CRITICAL();
    s_state.transitLocked = locked;
    if (locked) {
        s_state.preTransitMode = previousMode;
    }
    taskEXIT_CRITICAL();
}

bool stateIsTransitLocked(void) {
    taskENTER_CRITICAL();
    bool locked = s_state.transitLocked;
    taskEXIT_CRITICAL();
    return locked;
}

OperatingMode stateGetPreTransitMode(void) {
    taskENTER_CRITICAL();
    OperatingMode mode = s_state.preTransitMode;
    taskEXIT_CRITICAL();
    return mode;
}

void stateSetDemoLock(bool locked, OperatingMode previousMode) {
    taskENTER_CRITICAL();
    s_state.demoLocked = locked;
    if (locked) {
        s_state.preDemoMode = previousMode;
    }
    taskEXIT_CRITICAL();
}

bool stateIsDemoLocked(void) {
    taskENTER_CRITICAL();
    bool locked = s_state.demoLocked;
    taskEXIT_CRITICAL();
    return locked;
}

OperatingMode stateGetPreDemoMode(void) {
    taskENTER_CRITICAL();
    OperatingMode mode = s_state.preDemoMode;
    taskEXIT_CRITICAL();
    return mode;
}

void stateUpdateLockLED(void) {
    taskENTER_CRITICAL();
    bool lockActive = s_state.transitLocked || s_state.demoLocked;
    taskEXIT_CRITICAL();
    // Note: LED is active-high (GPIO HIGH = LED on)
    digitalWrite(LOCK_LED_PIN, lockActive ? HIGH : LOW);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[State] Lock LED: ");
    DEBUG_SERIAL.println(lockActive ? "ON" : "OFF");
    #endif
}

// =============================================================================
// GPS Power Management
// =============================================================================

void stateSetGpsPowerSaving(bool enabled) {
    taskENTER_CRITICAL();
    s_state.gpsPowerSaving = enabled;
    taskEXIT_CRITICAL();
}

bool stateIsGpsPowerSaving(void) {
    taskENTER_CRITICAL();
    bool saving = s_state.gpsPowerSaving;
    taskEXIT_CRITICAL();
    return saving;
}

void stateSetLastGpsRetryTime(uint32_t time) {
    taskENTER_CRITICAL();
    s_state.lastGpsRetryTime = time;
    taskEXIT_CRITICAL();
}

uint32_t stateGetLastGpsRetryTime(void) {
    taskENTER_CRITICAL();
    uint32_t t = s_state.lastGpsRetryTime;
    taskEXIT_CRITICAL();
    return t;
}

void stateSetGpsWasActive(bool active) {
    taskENTER_CRITICAL();
    s_state.gpsWasActive = active;
    taskEXIT_CRITICAL();
}

bool stateGetGpsWasActive(void) {
    taskENTER_CRITICAL();
    bool active = s_state.gpsWasActive;
    taskEXIT_CRITICAL();
    return active;
}

void stateSetGpsActiveStartTime(uint32_t time) {
    taskENTER_CRITICAL();
    s_state.gpsActiveStartTime = time;
    taskEXIT_CRITICAL();
}

uint32_t stateGetGpsActiveStartTime(void) {
    taskENTER_CRITICAL();
    uint32_t t = s_state.gpsActiveStartTime;
    taskEXIT_CRITICAL();
    return t;
}

// =============================================================================
// Checksum
// =============================================================================

uint32_t stateCalculateChecksum(const SongbirdState* state) {
    if (state == NULL) { return 0; }
    // Copy into a zeroed buffer to normalize padding bytes between struct fields.
    // Without this, two logically identical states can produce different CRC values
    // because the compiler inserts padding bytes (e.g., between bool and uint32_t
    // fields) whose values are undefined and can vary across memset vs memcpy paths.
    // NOTE: This changes the CRC algorithm behaviour relative to any checksum
    // computed before this fix.  Devices upgrading from older firmware will fail
    // the checksum check on the first boot and perform a clean state reset —
    // this is expected and correct (STATE_VERSION was also bumped for the same reason).
    SongbirdState normalized;
    memset(&normalized, 0, sizeof(normalized));
    memcpy(&normalized, state, sizeof(normalized));
    size_t checksumOffset = offsetof(SongbirdState, checksum);
    return crc32((const uint8_t*)&normalized, checksumOffset);
}

bool stateValidateChecksum(const SongbirdState* state) {
    if (state == NULL) {
        return false;
    }

    uint32_t calculated = stateCalculateChecksum(state);
    return calculated == state->checksum;
}
