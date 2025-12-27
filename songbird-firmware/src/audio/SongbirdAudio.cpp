/**
 * @file SongbirdAudio.cpp
 * @brief Audio/buzzer implementation for Songbird using SparkFun Qwiic Buzzer
 *
 * Uses the SparkFun Qwiic Buzzer (I2C) for audio feedback.
 * I2C access is protected by mutex for thread safety.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdAudio.h"
#include "SparkFun_Qwiic_Buzzer_Arduino_Library.h"

// =============================================================================
// Module State
// =============================================================================

static QwiicBuzzer s_buzzer;
static bool s_audioEnabled = DEFAULT_AUDIO_ENABLED;
static uint8_t s_audioVolume = DEFAULT_AUDIO_VOLUME;
static bool s_alertsOnly = DEFAULT_AUDIO_ALERTS_ONLY;
static bool s_initialized = false;

// =============================================================================
// Event Names (for debugging)
// =============================================================================

static const char* const EVENT_NAMES[] = {
    "POWER_ON",
    "CONNECTED",
    "GPS_LOCK",
    "NOTE_SENT",
    "MOTION",
    "TEMP_ALERT",
    "HUMIDITY_ALERT",
    "LOW_BATTERY",
    "BUTTON",
    "SLEEP",
    "ERROR",
    "PING",
    "LOCATE_START",
    "LOCATE_STOP",
    "CUSTOM_TONE"
};

// =============================================================================
// Volume Conversion
// =============================================================================

/**
 * @brief Convert 0-100 volume to Qwiic Buzzer volume constant
 *
 * Qwiic Buzzer has 5 discrete volume levels:
 * - SFE_QWIIC_BUZZER_VOLUME_OFF (0)
 * - SFE_QWIIC_BUZZER_VOLUME_MIN (1)
 * - SFE_QWIIC_BUZZER_VOLUME_LOW (2)
 * - SFE_QWIIC_BUZZER_VOLUME_MID (3)
 * - SFE_QWIIC_BUZZER_VOLUME_MAX (4)
 */
static uint8_t volumeToQwiic(uint8_t volume) {
    if (volume == 0) {
        return SFE_QWIIC_BUZZER_VOLUME_OFF;
    } else if (volume <= 25) {
        return SFE_QWIIC_BUZZER_VOLUME_MIN;
    } else if (volume <= 50) {
        return SFE_QWIIC_BUZZER_VOLUME_LOW;
    } else if (volume <= 75) {
        return SFE_QWIIC_BUZZER_VOLUME_MID;
    } else {
        return SFE_QWIIC_BUZZER_VOLUME_MAX;
    }
}

/**
 * @brief Check if we need to use RTOS primitives
 *
 * Returns true only if:
 * 1. The I2C mutex exists (syncInit() has been called)
 * 2. The scheduler is actually running
 *
 * @return true if RTOS primitives should be used
 */
static inline bool useRtosPrimitives(void) {
    // Check if mutex exists (syncInit called) AND scheduler is running
    extern SemaphoreHandle_t g_i2cMutex;
    return (g_i2cMutex != NULL) && (xTaskGetSchedulerState() == taskSCHEDULER_RUNNING);
}

// =============================================================================
// Initialization
// =============================================================================

bool audioInit(void) {
    // Note: Called during setup() before FreeRTOS starts, so no mutex needed.
    // I2C bus is already initialized by main.cpp before this is called.

    // Initialize Qwiic Buzzer at default address
    if (s_buzzer.begin(QWIIC_BUZZER_ADDRESS)) {
        s_initialized = true;
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Audio] Qwiic Buzzer initialized");
        #endif
        return true;
    } else {
        s_initialized = false;
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Audio] Qwiic Buzzer not found!");
        #endif
        return false;
    }
}

// =============================================================================
// Low-Level Tone Generation
// =============================================================================

void audioPlayTone(uint16_t frequency, uint16_t durationMs, uint8_t volume) {
    if (!s_initialized || !s_audioEnabled) {
        return;
    }

    bool useRtos = useRtosPrimitives();

    // Handle rest/silence
    if (frequency == 0 || volume == 0) {
        if (durationMs > 0) {
            if (useRtos) {
                vTaskDelay(pdMS_TO_TICKS(durationMs));
            } else {
                delay(durationMs);
            }
        }
        return;
    }

    // Clamp volume to valid range
    volume = CLAMP(volume, 0, 100);
    uint8_t qwiicVolume = volumeToQwiic(volume);

    // Take I2C mutex only if scheduler is running
    // Use longer timeout for audio since Notecard operations can be slow
    if (useRtos) {
        if (!syncAcquireI2C(5000)) {
            return;
        }
    }

    // Configure and play tone
    // The Qwiic Buzzer handles timing internally when duration > 0
    s_buzzer.configureBuzzer(frequency, durationMs, qwiicVolume);
    s_buzzer.on();

    if (useRtos) {
        syncReleaseI2C();
        // Wait for tone to complete
        vTaskDelay(pdMS_TO_TICKS(durationMs));
    } else {
        // Pre-scheduler: use blocking delay
        delay(durationMs);
    }
}

void audioStop(void) {
    if (!s_initialized) {
        return;
    }

    bool useRtos = useRtosPrimitives();

    if (useRtos) {
        if (!syncAcquireI2C(5000)) {
            return;
        }
    }

    s_buzzer.off();

    if (useRtos) {
        syncReleaseI2C();
    }
}

// =============================================================================
// Melody Playback
// =============================================================================

void audioPlayMelody(const Melody* melody, uint8_t volume) {
    if (!s_initialized || !s_audioEnabled || melody == NULL) {
        return;
    }

    for (uint8_t i = 0; i < melody->length; i++) {
        audioPlayTone(melody->notes[i], melody->durations[i], volume);

        // Small gap between notes (unless it's a rest)
        if (melody->notes[i] != NOTE_REST && i < melody->length - 1) {
            vTaskDelay(pdMS_TO_TICKS(TONE_GAP_MS));
        }
    }
}

void audioPlayEvent(AudioEventType event, uint8_t volume) {
    // Check if we should play this event
    if (!s_audioEnabled) {
        return;
    }

    // In alerts-only mode, skip non-alert events
    if (s_alertsOnly && !audioIsAlertEvent(event)) {
        return;
    }

    // Get melody for this event
    const Melody* melody = getMelody(event);
    if (melody != NULL) {
        audioPlayMelody(melody, volume);
    }
}

// =============================================================================
// Enable/Disable Control
// =============================================================================

void audioSetEnabled(bool enabled) {
    s_audioEnabled = enabled;
    if (!enabled) {
        audioStop();
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Audio] ");
    DEBUG_SERIAL.println(enabled ? "Enabled" : "Disabled");
    #endif
}

bool audioIsEnabled(void) {
    return s_audioEnabled;
}

bool audioToggleMute(void) {
    bool newState = !s_audioEnabled;

    if (!s_initialized) {
        s_audioEnabled = newState;
        return s_audioEnabled;
    }

    // For unmuting: enable audio first so the confirmation tone plays
    // For muting: audio is already enabled, play tone then disable
    if (newState) {
        // Unmuting - enable first, then play rising confirmation tone (C→E→G)
        s_audioEnabled = true;
        audioPlayTone(NOTE_C5, 80, s_audioVolume);
        vTaskDelay(pdMS_TO_TICKS(30));
        audioPlayTone(NOTE_E5, 80, s_audioVolume);
        vTaskDelay(pdMS_TO_TICKS(30));
        audioPlayTone(NOTE_G5, 100, s_audioVolume);
    } else {
        // Muting - play falling confirmation tone (G→E→C), then disable
        audioPlayTone(NOTE_G5, 80, s_audioVolume);
        vTaskDelay(pdMS_TO_TICKS(30));
        audioPlayTone(NOTE_E5, 80, s_audioVolume);
        vTaskDelay(pdMS_TO_TICKS(30));
        audioPlayTone(NOTE_C5, 100, s_audioVolume);
        s_audioEnabled = false;
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Audio] Mute toggled: ");
    DEBUG_SERIAL.println(s_audioEnabled ? "UNMUTED" : "MUTED");
    #endif

    return s_audioEnabled;
}

void audioSetVolume(uint8_t volume) {
    s_audioVolume = CLAMP(volume, 0, 100);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Audio] Volume: ");
    DEBUG_SERIAL.println(s_audioVolume);
    #endif
}

uint8_t audioGetVolume(void) {
    return s_audioVolume;
}

void audioSetAlertsOnly(bool alertsOnly) {
    s_alertsOnly = alertsOnly;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Audio] Alerts only: ");
    DEBUG_SERIAL.println(alertsOnly ? "Yes" : "No");
    #endif
}

bool audioIsAlertsOnly(void) {
    return s_alertsOnly;
}

// =============================================================================
// Queue-Based Interface
// =============================================================================

bool audioQueueEvent(AudioEventType event) {
    if (!s_audioEnabled) {
        return false;
    }

    // In alerts-only mode, skip non-alert events
    if (s_alertsOnly && !audioIsAlertEvent(event)) {
        return false;
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Audio] Queueing: ");
    DEBUG_SERIAL.println(audioGetEventName(event));
    #endif

    return syncQueueAudio(event);
}

bool audioQueueTone(uint16_t frequency, uint16_t durationMs) {
    if (!s_audioEnabled) {
        return false;
    }

    AudioQueueItem item;
    memset(&item, 0, sizeof(item));
    item.event = AUDIO_EVENT_CUSTOM_TONE;
    item.frequency = frequency;
    item.durationMs = durationMs;

    return syncQueueAudioItem(&item);
}

bool audioStartLocate(uint16_t durationSec) {
    if (!s_audioEnabled) {
        return false;
    }

    AudioQueueItem item;
    memset(&item, 0, sizeof(item));
    item.event = AUDIO_EVENT_LOCATE_START;
    item.locateDurationSec = durationSec;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Audio] Starting locate mode for ");
    DEBUG_SERIAL.print(durationSec);
    DEBUG_SERIAL.println(" seconds");
    #endif

    return syncQueueAudioItem(&item);
}

bool audioStopLocate(void) {
    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Audio] Stopping locate mode");
    #endif

    return syncQueueAudio(AUDIO_EVENT_LOCATE_STOP);
}

// =============================================================================
// Helper Functions
// =============================================================================

bool audioIsAlertEvent(AudioEventType event) {
    switch (event) {
        case AUDIO_EVENT_TEMP_ALERT:
        case AUDIO_EVENT_HUMIDITY_ALERT:
        case AUDIO_EVENT_LOW_BATTERY:
        case AUDIO_EVENT_ERROR:
        case AUDIO_EVENT_PING:          // Commands should always play
        case AUDIO_EVENT_LOCATE_START:  // Locate should always work
            return true;
        default:
            return false;
    }
}

const char* audioGetEventName(AudioEventType event) {
    if (event < AUDIO_EVENT_COUNT) {
        return EVENT_NAMES[event];
    }
    return "UNKNOWN";
}
