/**
 * @file SongbirdMelodies.h
 * @brief Musical note frequencies and melody definitions for Songbird
 *
 * Defines all audio feedback melodies used by the device:
 * - Power on/off sequences
 * - Connection status
 * - Alerts and notifications
 * - Command feedback
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_MELODIES_H
#define SONGBIRD_MELODIES_H

#include <stdint.h>

// =============================================================================
// Musical Note Frequencies (Hz)
// =============================================================================

// Rest (silence)
#define NOTE_REST   0

// Octave 4
#define NOTE_C4     262
#define NOTE_CS4    277
#define NOTE_D4     294
#define NOTE_DS4    311
#define NOTE_E4     330
#define NOTE_F4     349
#define NOTE_FS4    370
#define NOTE_G4     392
#define NOTE_GS4    415
#define NOTE_A4     440
#define NOTE_AS4    466
#define NOTE_B4     494

// Octave 5
#define NOTE_C5     523
#define NOTE_CS5    554
#define NOTE_D5     587
#define NOTE_DS5    622
#define NOTE_E5     659
#define NOTE_F5     698
#define NOTE_FS5    740
#define NOTE_G5     784
#define NOTE_GS5    831
#define NOTE_A5     880
#define NOTE_AS5    932
#define NOTE_B5     988

// Octave 6
#define NOTE_C6     1047
#define NOTE_CS6    1109
#define NOTE_D6     1175
#define NOTE_DS6    1245
#define NOTE_E6     1319
#define NOTE_F6     1397
#define NOTE_FS6    1480
#define NOTE_G6     1568
#define NOTE_GS6    1661
#define NOTE_A6     1760
#define NOTE_AS6    1865
#define NOTE_B6     1976

// Special tones
#define NOTE_ERROR  200     // Low buzz for errors

// =============================================================================
// Melody Structure
// =============================================================================

typedef struct {
    const uint16_t* notes;      // Array of frequencies
    const uint16_t* durations;  // Array of durations (ms)
    uint8_t length;             // Number of notes
} Melody;

// =============================================================================
// Power On - Quick boot beeps: two short beeps
// Technical startup confirmation
// =============================================================================

static const uint16_t MELODY_POWER_ON_NOTES[] = {
    NOTE_G5, NOTE_REST, NOTE_C6
};
static const uint16_t MELODY_POWER_ON_DURATIONS[] = {
    60, 40, 100
};
static const Melody MELODY_POWER_ON = {
    MELODY_POWER_ON_NOTES,
    MELODY_POWER_ON_DURATIONS,
    3
};

// =============================================================================
// Connected - Musical flourish: rising "ta-da" fanfare
// "Songbird melody" - played on successful Notehub connection
// =============================================================================

static const uint16_t MELODY_CONNECTED_NOTES[] = {
    NOTE_G5, NOTE_C6, NOTE_E6, NOTE_G6
};
static const uint16_t MELODY_CONNECTED_DURATIONS[] = {
    80, 80, 80, 250
};
static const Melody MELODY_CONNECTED = {
    MELODY_CONNECTED_NOTES,
    MELODY_CONNECTED_DURATIONS,
    4
};

// =============================================================================
// GPS Lock - Two short G5 beeps
// Confirms location acquired
// =============================================================================

static const uint16_t MELODY_GPS_LOCK_NOTES[] = {
    NOTE_G5, NOTE_REST, NOTE_G5
};
static const uint16_t MELODY_GPS_LOCK_DURATIONS[] = {
    80, 40, 80
};
static const Melody MELODY_GPS_LOCK = {
    MELODY_GPS_LOCK_NOTES,
    MELODY_GPS_LOCK_DURATIONS,
    3
};

// =============================================================================
// Temperature Alert - Ascending urgent C5→E5→G5
// High or low temperature threshold exceeded
// =============================================================================

static const uint16_t MELODY_TEMP_ALERT_NOTES[] = {
    NOTE_C5, NOTE_E5, NOTE_G5
};
static const uint16_t MELODY_TEMP_ALERT_DURATIONS[] = {
    120, 120, 160
};
static const Melody MELODY_TEMP_ALERT = {
    MELODY_TEMP_ALERT_NOTES,
    MELODY_TEMP_ALERT_DURATIONS,
    3
};

// =============================================================================
// Humidity Alert - Descending tone G5→E5→C5
// High or low humidity threshold exceeded
// =============================================================================

static const uint16_t MELODY_HUMIDITY_ALERT_NOTES[] = {
    NOTE_G5, NOTE_E5, NOTE_C5
};
static const uint16_t MELODY_HUMIDITY_ALERT_DURATIONS[] = {
    120, 120, 160
};
static const Melody MELODY_HUMIDITY_ALERT = {
    MELODY_HUMIDITY_ALERT_NOTES,
    MELODY_HUMIDITY_ALERT_DURATIONS,
    3
};

// =============================================================================
// Low Battery - Slow sad tones C5→A4→F4
// Battery needs charging
// =============================================================================

static const uint16_t MELODY_LOW_BATTERY_NOTES[] = {
    NOTE_C5, NOTE_A4, NOTE_F4
};
static const uint16_t MELODY_LOW_BATTERY_DURATIONS[] = {
    200, 200, 200
};
static const Melody MELODY_LOW_BATTERY = {
    MELODY_LOW_BATTERY_NOTES,
    MELODY_LOW_BATTERY_DURATIONS,
    3
};

// =============================================================================
// Entering Sleep - Descending fade C6→G5→C5
// Device entering low-power mode
// =============================================================================

static const uint16_t MELODY_SLEEP_NOTES[] = {
    NOTE_C6, NOTE_G5, NOTE_C5
};
static const uint16_t MELODY_SLEEP_DURATIONS[] = {
    100, 100, 100
};
static const Melody MELODY_SLEEP = {
    MELODY_SLEEP_NOTES,
    MELODY_SLEEP_DURATIONS,
    3
};

// =============================================================================
// Error - Low buzz/raspberry
// Operation failed
// =============================================================================

static const uint16_t MELODY_ERROR_NOTES[] = {
    NOTE_ERROR
};
static const uint16_t MELODY_ERROR_DURATIONS[] = {
    300
};
static const Melody MELODY_ERROR = {
    MELODY_ERROR_NOTES,
    MELODY_ERROR_DURATIONS,
    1
};

// =============================================================================
// Ping/Notification - Bright chime G5→C6→E6
// Cloud-triggered notification
// =============================================================================

static const uint16_t MELODY_PING_NOTES[] = {
    NOTE_G5, NOTE_C6, NOTE_E6
};
static const uint16_t MELODY_PING_DURATIONS[] = {
    100, 100, 200
};
static const Melody MELODY_PING = {
    MELODY_PING_NOTES,
    MELODY_PING_DURATIONS,
    3
};

// =============================================================================
// Locate Pattern - Single C6 beep (repeated by caller)
// "Find my device" beacon
// =============================================================================

static const uint16_t MELODY_LOCATE_NOTES[] = {
    NOTE_C6
};
static const uint16_t MELODY_LOCATE_DURATIONS[] = {
    150
};
static const Melody MELODY_LOCATE = {
    MELODY_LOCATE_NOTES,
    MELODY_LOCATE_DURATIONS,
    1
};

// =============================================================================
// Command Acknowledgment - Quick E6
// Command received from cloud
// =============================================================================

static const uint16_t MELODY_CMD_ACK_NOTES[] = {
    NOTE_E6
};
static const uint16_t MELODY_CMD_ACK_DURATIONS[] = {
    100
};
static const Melody MELODY_CMD_ACK = {
    MELODY_CMD_ACK_NOTES,
    MELODY_CMD_ACK_DURATIONS,
    1
};

// =============================================================================
// Pressure Alert - Warbling tone (alternating)
// Significant pressure change detected
// =============================================================================

static const uint16_t MELODY_PRESSURE_ALERT_NOTES[] = {
    NOTE_E5, NOTE_G5, NOTE_E5, NOTE_G5
};
static const uint16_t MELODY_PRESSURE_ALERT_DURATIONS[] = {
    100, 100, 100, 100
};
static const Melody MELODY_PRESSURE_ALERT = {
    MELODY_PRESSURE_ALERT_NOTES,
    MELODY_PRESSURE_ALERT_DURATIONS,
    4
};

// =============================================================================
// Transit Lock ON - Descending lock sound E6→C6→G5
// Double-click to engage transit lock
// =============================================================================

static const uint16_t MELODY_TRANSIT_LOCK_ON_NOTES[] = {
    NOTE_E6, NOTE_C6, NOTE_REST, NOTE_G5
};
static const uint16_t MELODY_TRANSIT_LOCK_ON_DURATIONS[] = {
    80, 80, 50, 150
};
static const Melody MELODY_TRANSIT_LOCK_ON = {
    MELODY_TRANSIT_LOCK_ON_NOTES,
    MELODY_TRANSIT_LOCK_ON_DURATIONS,
    4
};

// =============================================================================
// Transit Lock OFF - Ascending unlock sound G5→C6→E6
// Double-click to disengage transit lock
// =============================================================================

static const uint16_t MELODY_TRANSIT_LOCK_OFF_NOTES[] = {
    NOTE_G5, NOTE_C6, NOTE_REST, NOTE_E6
};
static const uint16_t MELODY_TRANSIT_LOCK_OFF_DURATIONS[] = {
    80, 80, 50, 150
};
static const Melody MELODY_TRANSIT_LOCK_OFF = {
    MELODY_TRANSIT_LOCK_OFF_NOTES,
    MELODY_TRANSIT_LOCK_OFF_DURATIONS,
    4
};

// =============================================================================
// Demo Lock ON - Higher pitched descending lock A6→F6→D6
// Triple-click to engage demo lock
// =============================================================================

static const uint16_t MELODY_DEMO_LOCK_ON_NOTES[] = {
    NOTE_A6, NOTE_F6, NOTE_REST, NOTE_D6
};
static const uint16_t MELODY_DEMO_LOCK_ON_DURATIONS[] = {
    80, 80, 50, 150
};
static const Melody MELODY_DEMO_LOCK_ON = {
    MELODY_DEMO_LOCK_ON_NOTES,
    MELODY_DEMO_LOCK_ON_DURATIONS,
    4
};

// =============================================================================
// Demo Lock OFF - Higher pitched ascending unlock D6→F6→A6
// Triple-click to disengage demo lock
// =============================================================================

static const uint16_t MELODY_DEMO_LOCK_OFF_NOTES[] = {
    NOTE_D6, NOTE_F6, NOTE_REST, NOTE_A6
};
static const uint16_t MELODY_DEMO_LOCK_OFF_DURATIONS[] = {
    80, 80, 50, 150
};
static const Melody MELODY_DEMO_LOCK_OFF = {
    MELODY_DEMO_LOCK_OFF_NOTES,
    MELODY_DEMO_LOCK_OFF_DURATIONS,
    4
};

// =============================================================================
// Melody Lookup Table
// =============================================================================

// Array index corresponds to AudioEventType enum values
static const Melody* const MELODY_TABLE[] = {
    &MELODY_POWER_ON,         // AUDIO_EVENT_POWER_ON
    &MELODY_CONNECTED,        // AUDIO_EVENT_CONNECTED
    &MELODY_GPS_LOCK,         // AUDIO_EVENT_GPS_LOCK
    &MELODY_TEMP_ALERT,       // AUDIO_EVENT_TEMP_ALERT
    &MELODY_HUMIDITY_ALERT,   // AUDIO_EVENT_HUMIDITY_ALERT
    &MELODY_LOW_BATTERY,      // AUDIO_EVENT_LOW_BATTERY
    &MELODY_SLEEP,            // AUDIO_EVENT_SLEEP
    &MELODY_ERROR,            // AUDIO_EVENT_ERROR
    &MELODY_PING,             // AUDIO_EVENT_PING
    &MELODY_LOCATE,           // AUDIO_EVENT_LOCATE_START (single beep)
    NULL,                     // AUDIO_EVENT_LOCATE_STOP (no sound)
    NULL,                     // AUDIO_EVENT_CUSTOM_TONE (handled separately)
    &MELODY_TRANSIT_LOCK_ON,  // AUDIO_EVENT_TRANSIT_LOCK_ON
    &MELODY_TRANSIT_LOCK_OFF, // AUDIO_EVENT_TRANSIT_LOCK_OFF
    &MELODY_DEMO_LOCK_ON,     // AUDIO_EVENT_DEMO_LOCK_ON
    &MELODY_DEMO_LOCK_OFF     // AUDIO_EVENT_DEMO_LOCK_OFF
};

/**
 * @brief Get melody for an audio event type
 *
 * @param event The audio event type
 * @return Pointer to melody, or NULL if no melody for this event
 */
static inline const Melody* getMelody(uint8_t event) {
    if (event < sizeof(MELODY_TABLE) / sizeof(MELODY_TABLE[0])) {
        return MELODY_TABLE[event];
    }
    return NULL;
}

#endif // SONGBIRD_MELODIES_H
