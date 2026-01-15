/**
 * @file SongbirdConfig.h
 * @brief Configuration constants, pin definitions, and type definitions for Songbird
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_CONFIG_H
#define SONGBIRD_CONFIG_H

#include <stdint.h>
#include <stdbool.h>

// =============================================================================
// Product Configuration
// =============================================================================

#ifndef PRODUCT_UID
#define PRODUCT_UID "com.blues.songbird"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.0"
#endif

// Firmware metadata for Outboard DFU (ODFU)
#define FIRMWARE_ORG        "Blues Inc."
#define FIRMWARE_PRODUCT    "Songbird"
#define FIRMWARE_DESCRIPTION "Sales demo asset tracker"

// Build information (set via build flags or defaults)
#ifndef BUILD_NUMBER
#define BUILD_NUMBER        "0"
#endif

#ifndef BUILD_TIMESTAMP
#define BUILD_TIMESTAMP     __DATE__ " " __TIME__
#endif

// DFU target architecture for STM32L433 (Cygnet) and ODFU Mode
#define DFU_TARGET          "stm32"
#define DFU_MODE            "altdfu" // Use ALT_DFU pins (for Notecarrier CX)

// =============================================================================
// Pin Definitions (Blues Cygnet - STM32L433)
// =============================================================================

#define BUTTON_PIN      USER_BTN    // User button (optional), internal pull-up
#define LED_PIN         LED_BUILTIN // Built-in LED on Cygnet

// =============================================================================
// Debug Serial Configuration (STLink VCP)
// =============================================================================

// Serial is defined in main.cpp and exported here for all modules
#define SERIAL_BAUD 115200

#ifdef __cplusplus
#include <HardwareSerial.h>
extern HardwareSerial serialDebug;
#define DEBUG_SERIAL serialDebug
#endif

// =============================================================================
// I2C Configuration
// =============================================================================

#define BME280_I2C_ADDRESS      0x77    // SparkFun/Adafruit Qwiic default
#define NOTECARD_I2C_ADDRESS    0x17    // Notecard default address
#define QWIIC_BUZZER_ADDRESS    0x34    // SparkFun Qwiic Buzzer default

// =============================================================================
// FreeRTOS Task Configuration
// =============================================================================

// Task Priorities (higher number = higher priority)
// Range: 0 to (configMAX_PRIORITIES - 1) = 0 to 4
#define PRIORITY_ENV        1   // Lowest - config changes are not time-critical
#define PRIORITY_MAIN       2   // Normal - orchestration
#define PRIORITY_SENSOR     2   // Normal - periodic reads
#define PRIORITY_AUDIO      3   // Above normal - responsive audio
#define PRIORITY_COMMAND    3   // Above normal - responsive commands
#define PRIORITY_NOTECARD   4   // Highest - time-sensitive sync operations

// Task Stack Sizes (in words, not bytes - multiply by 4 for bytes)
#define STACK_MAIN          512     // 2KB
#define STACK_SENSOR        512     // 2KB
#define STACK_AUDIO         256     // 1KB
#define STACK_COMMAND       512     // 2KB
#define STACK_NOTECARD      1024    // 4KB (Notecard library needs more)
#define STACK_ENV           512     // 2KB

// Queue Sizes
#define AUDIO_QUEUE_SIZE    8       // Audio events pending
#define NOTE_QUEUE_SIZE     16      // Outbound notes pending
#define CONFIG_QUEUE_SIZE   4       // Config updates pending

// =============================================================================
// Operating Modes
// =============================================================================

typedef enum {
    MODE_DEMO = 0,      // Fastest reporting, immediate sync
    MODE_TRANSIT = 1,   // Balanced reporting for active transit
    MODE_STORAGE = 2,   // Infrequent reporting for storage
    MODE_SLEEP = 3      // Minimal activity, motion wake only
} OperatingMode;

// Mode preset intervals (in minutes unless noted)
// Mode          GPS     Sync    Motion Sensitivity
// demo          1       immediate   high
// transit       5       15          medium
// storage       60      60          low
// sleep         off     on-motion   wake-on-motion

// =============================================================================
// Motion Sensitivity
// =============================================================================

typedef enum {
    MOTION_SENSITIVITY_LOW = 0,
    MOTION_SENSITIVITY_MEDIUM = 1,
    MOTION_SENSITIVITY_HIGH = 2
} MotionSensitivity;

// Notecard motion sensitivity values (card.motion)
#define MOTION_THRESHOLD_LOW        3.0     // Less sensitive
#define MOTION_THRESHOLD_MEDIUM     1.5     // Default
#define MOTION_THRESHOLD_HIGH       0.5     // More sensitive

// =============================================================================
// Alert Types
// =============================================================================

#define ALERT_TYPE_TEMP_HIGH        "temp_high"
#define ALERT_TYPE_TEMP_LOW         "temp_low"
#define ALERT_TYPE_HUMIDITY_HIGH    "humidity_high"
#define ALERT_TYPE_HUMIDITY_LOW     "humidity_low"
#define ALERT_TYPE_PRESSURE_DELTA   "pressure_change"
#define ALERT_TYPE_LOW_BATTERY      "low_battery"
#define ALERT_TYPE_MOTION           "motion"

// Alert bitmask for tracking which alerts have been sent
#define ALERT_FLAG_TEMP_HIGH        (1 << 0)
#define ALERT_FLAG_TEMP_LOW         (1 << 1)
#define ALERT_FLAG_HUMIDITY_HIGH    (1 << 2)
#define ALERT_FLAG_HUMIDITY_LOW     (1 << 3)
#define ALERT_FLAG_PRESSURE_DELTA   (1 << 4)
#define ALERT_FLAG_LOW_BATTERY      (1 << 5)
#define ALERT_FLAG_MOTION           (1 << 6)

// =============================================================================
// Notefile Names
// =============================================================================

#define NOTEFILE_TRACK      "track.qo"      // Outbound tracking data
#define NOTEFILE_ALERT      "alert.qo"      // Outbound alerts
#define NOTEFILE_COMMAND    "command.qi"    // Inbound commands
#define NOTEFILE_CMD_ACK    "command_ack.qo" // Outbound command acknowledgments
#define NOTEFILE_HEALTH     "health.qo"     // Outbound device health

// =============================================================================
// Default Configuration Values
// =============================================================================

#define DEFAULT_MODE                    MODE_DEMO
#define DEFAULT_GPS_INTERVAL_MIN        5
#define DEFAULT_SYNC_INTERVAL_MIN       15
#define DEFAULT_HEARTBEAT_HOURS         24

// Alert thresholds
#define DEFAULT_TEMP_ALERT_HIGH_C       35.0f
#define DEFAULT_TEMP_ALERT_LOW_C        0.0f
#define DEFAULT_HUMIDITY_ALERT_HIGH     80.0f
#define DEFAULT_HUMIDITY_ALERT_LOW      20.0f
#define DEFAULT_PRESSURE_ALERT_DELTA    10.0f   // hPa change
#define DEFAULT_VOLTAGE_ALERT_LOW       3.4f    // Volts

// Motion
#define DEFAULT_MOTION_SENSITIVITY      MOTION_SENSITIVITY_MEDIUM
#define DEFAULT_MOTION_WAKE_ENABLED     true

// Audio
#define DEFAULT_AUDIO_ENABLED           true
#define DEFAULT_AUDIO_VOLUME            80      // 0-100
#define DEFAULT_AUDIO_ALERTS_ONLY       false

// Command & Control
#define DEFAULT_CMD_WAKE_ENABLED        true
#define DEFAULT_CMD_ACK_ENABLED         true
#define DEFAULT_LOCATE_DURATION_SEC     30

// Debug
#define DEFAULT_LED_ENABLED             true
#define DEFAULT_DEBUG_MODE              false

// GPS Power Management (Transit Mode)
// When enabled, monitors GPS activity and disables GPS if no signal within timeout
#define DEFAULT_GPS_POWER_SAVE_ENABLED  true
#define DEFAULT_GPS_SIGNAL_TIMEOUT_MIN  15      // Minutes to wait for GPS signal before disabling
#define DEFAULT_GPS_RETRY_INTERVAL_MIN  30      // Minutes between GPS retry attempts

// =============================================================================
// Task Intervals (milliseconds)
// =============================================================================

// Sensor read intervals per mode
#define SENSOR_INTERVAL_DEMO_MS         60000   // 60 seconds
#define SENSOR_INTERVAL_TRANSIT_MS      60000   // 1 minute
#define SENSOR_INTERVAL_STORAGE_MS      300000  // 5 minutes
#define SENSOR_INTERVAL_SLEEP_MS        0       // Disabled (wake-on-motion)

// Command polling intervals per mode
#define COMMAND_POLL_DEMO_MS            1000    // 1 second (responsive)
#define COMMAND_POLL_TRANSIT_MS         30000   // 30 seconds
#define COMMAND_POLL_STORAGE_MS         60000   // 60 seconds
#define COMMAND_POLL_SLEEP_MS           0       // Disabled (wake handles)

// Environment variable polling
#define ENV_POLL_INTERVAL_MS            30000   // 30 seconds

// Notecard sync check interval
#define SYNC_CHECK_INTERVAL_MS          5000    // 5 seconds

// Main task loop interval
#define MAIN_LOOP_INTERVAL_MS           100     // 100ms

// =============================================================================
// Timeouts
// =============================================================================

#define I2C_MUTEX_TIMEOUT_MS            1000    // 1 second
#define NOTECARD_RESPONSE_TIMEOUT_MS    10000   // 10 seconds
#define GPS_FIX_TIMEOUT_MS              120000  // 2 minutes
#define NOTEHUB_CONNECT_TIMEOUT_MS      30000   // 30 seconds
#define SLEEP_COORDINATION_TIMEOUT_MS   5000    // 5 seconds

// =============================================================================
// Audio Configuration
// =============================================================================

#define BUZZER_DEFAULT_FREQUENCY        4000    // 4kHz resonant frequency
#define LOCATE_PAUSE_MS                 850     // Pause between locate beeps
#define TONE_GAP_MS                     50      // Gap between melody notes

// =============================================================================
// Configuration Structure
// =============================================================================

typedef struct {
    // Operating mode
    OperatingMode mode;

    // Timing (in minutes)
    uint16_t gpsIntervalMin;
    uint16_t syncIntervalMin;
    uint16_t heartbeatHours;

    // Alert thresholds
    float tempAlertHighC;
    float tempAlertLowC;
    float humidityAlertHigh;
    float humidityAlertLow;
    float pressureAlertDelta;
    float voltageAlertLow;

    // Motion
    MotionSensitivity motionSensitivity;
    bool motionWakeEnabled;

    // Audio
    bool audioEnabled;
    uint8_t audioVolume;        // 0-100
    bool audioAlertsOnly;

    // Command & Control
    bool cmdWakeEnabled;
    bool cmdAckEnabled;
    uint16_t locateDurationSec;

    // Debug
    bool ledEnabled;
    bool debugMode;

    // GPS Power Management (Transit Mode)
    bool gpsPowerSaveEnabled;       // Actively manage GPS power based on signal
    uint8_t gpsSignalTimeoutMin;    // Minutes to wait for GPS signal before disabling
    uint8_t gpsRetryIntervalMin;    // Minutes between GPS retry attempts
} SongbirdConfig;

// =============================================================================
// Sensor Data Structure
// =============================================================================

typedef struct {
    float temperature;      // Celsius
    float humidity;         // Percent (0-100)
    float pressure;         // hPa
    float voltage;          // Battery voltage (for alert checking, not sent in track.qo)
    bool motion;            // Motion detected since last read
    bool valid;             // Data is valid (sensor read succeeded)
    uint32_t timestamp;     // Unix timestamp
} SensorData;

// =============================================================================
// Alert Structure
// =============================================================================

typedef struct {
    const char* type;       // Alert type string
    float value;            // Measured value that triggered alert
    float threshold;        // Threshold that was exceeded
    char message[64];       // Human-readable message
} Alert;

// =============================================================================
// Command Structures
// =============================================================================

typedef enum {
    CMD_PING = 0,
    CMD_LOCATE,
    CMD_PLAY_MELODY,
    CMD_TEST_AUDIO,
    CMD_SET_VOLUME,
    CMD_UNKNOWN
} CommandType;

typedef struct {
    CommandType type;
    char commandId[32];     // For acknowledgment tracking
    union {
        struct {
            uint16_t durationSec;
        } locate;
        struct {
            char melodyName[16];
        } playMelody;
        struct {
            uint16_t frequency;
            uint16_t durationMs;
        } testAudio;
        struct {
            uint8_t volume;
        } setVolume;
    } params;
} Command;

typedef enum {
    CMD_STATUS_OK = 0,
    CMD_STATUS_ERROR,
    CMD_STATUS_IGNORED
} CommandStatus;

typedef struct {
    char commandId[32];
    CommandType type;
    CommandStatus status;
    char message[64];
    uint32_t executedAt;
} CommandAck;

// =============================================================================
// Health Data Structure
// =============================================================================

typedef struct {
    char firmwareVersion[16];
    uint32_t uptimeSec;
    uint32_t bootCount;
    uint32_t lastGpsFixSec;
    uint8_t sensorErrors;
    uint8_t notecardErrors;
} HealthData;

// =============================================================================
// Helper Macros
// =============================================================================

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define CLAMP(x, low, high) (MIN(MAX((x), (low)), (high)))

// Convert minutes to milliseconds
#define MINUTES_TO_MS(m) ((m) * 60UL * 1000UL)

// Convert hours to seconds
#define HOURS_TO_SEC(h) ((h) * 3600UL)

#endif // SONGBIRD_CONFIG_H
