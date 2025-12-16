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
    s_state.bootCount++;
}

void stateUpdateSyncTime(void) {
    s_state.lastSyncTime = millis();
}

void stateUpdateGpsFixTime(void) {
    s_state.lastGpsFixTime = millis();
}

void stateUpdateLastPressure(float pressure) {
    s_state.lastPressure = pressure;
}

void stateSetMode(OperatingMode mode) {
    s_state.currentMode = mode;
}

void stateSetAlert(uint8_t alertFlag) {
    s_state.alertsSent |= alertFlag;
}

void stateClearAlert(uint8_t alertFlag) {
    s_state.alertsSent &= ~alertFlag;
}

uint8_t stateGetAlerts(void) {
    return s_state.alertsSent;
}

void stateSetMotion(bool motion) {
    if (motion) {
        s_state.motionSinceLastReport = true;
    }
}

bool stateGetAndClearMotion(void) {
    bool motion = s_state.motionSinceLastReport;
    s_state.motionSinceLastReport = false;
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
    return s_state.bootCount;
}

float stateGetLastPressure(void) {
    return s_state.lastPressure;
}

// =============================================================================
// Checksum
// =============================================================================

uint32_t stateCalculateChecksum(const SongbirdState* state) {
    if (state == NULL) {
        return 0;
    }

    // Calculate CRC over all fields except the checksum itself
    size_t checksumOffset = offsetof(SongbirdState, checksum);
    return crc32((const uint8_t*)state, checksumOffset);
}

bool stateValidateChecksum(const SongbirdState* state) {
    if (state == NULL) {
        return false;
    }

    uint32_t calculated = stateCalculateChecksum(state);
    return calculated == state->checksum;
}
