/**
 * @file SongbirdAudio.cpp
 * @brief Audio/buzzer implementation for Songbird
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdAudio.h"

// =============================================================================
// Module State
// =============================================================================

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
// Initialization
// =============================================================================

void audioInit(void) {
    // Configure buzzer pin as output
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);

    // Configure PWM for tone generation
    // Note: On STM32, analogWrite uses PWM automatically
    // Default frequency will be overridden by tone() calls

    s_initialized = true;

    #ifdef DEBUG_MODE
    Serial.println("[Audio] Initialized");
    #endif
}

// =============================================================================
// Low-Level Tone Generation
// =============================================================================

void audioPlayTone(uint16_t frequency, uint16_t durationMs, uint8_t volume) {
    if (!s_initialized || !s_audioEnabled) {
        return;
    }

    // Handle rest/silence
    if (frequency == 0 || volume == 0) {
        noTone(BUZZER_PIN);
        if (durationMs > 0) {
            vTaskDelay(pdMS_TO_TICKS(durationMs));
        }
        return;
    }

    // Clamp volume to valid range
    volume = CLAMP(volume, 0, 100);

    // Generate tone using Arduino tone() function
    // Note: tone() generates a square wave, volume is approximate
    // For true volume control, we'd need PWM duty cycle adjustment
    tone(BUZZER_PIN, frequency);

    // Wait for duration
    vTaskDelay(pdMS_TO_TICKS(durationMs));

    // Stop tone
    noTone(BUZZER_PIN);
}

void audioStop(void) {
    noTone(BUZZER_PIN);
    digitalWrite(BUZZER_PIN, LOW);
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
    Serial.print("[Audio] ");
    Serial.println(enabled ? "Enabled" : "Disabled");
    #endif
}

bool audioIsEnabled(void) {
    return s_audioEnabled;
}

void audioSetVolume(uint8_t volume) {
    s_audioVolume = CLAMP(volume, 0, 100);

    #ifdef DEBUG_MODE
    Serial.print("[Audio] Volume: ");
    Serial.println(s_audioVolume);
    #endif
}

uint8_t audioGetVolume(void) {
    return s_audioVolume;
}

void audioSetAlertsOnly(bool alertsOnly) {
    s_alertsOnly = alertsOnly;

    #ifdef DEBUG_MODE
    Serial.print("[Audio] Alerts only: ");
    Serial.println(alertsOnly ? "Yes" : "No");
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
    Serial.print("[Audio] Queueing: ");
    Serial.println(audioGetEventName(event));
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
    Serial.print("[Audio] Starting locate mode for ");
    Serial.print(durationSec);
    Serial.println(" seconds");
    #endif

    return syncQueueAudioItem(&item);
}

bool audioStopLocate(void) {
    #ifdef DEBUG_MODE
    Serial.println("[Audio] Stopping locate mode");
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
