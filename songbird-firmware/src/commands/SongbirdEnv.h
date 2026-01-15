/**
 * @file SongbirdEnv.h
 * @brief Environment variable management for Songbird
 *
 * Handles fetching, parsing, and applying configuration
 * from Notehub environment variables.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_ENV_H
#define SONGBIRD_ENV_H

#include <Arduino.h>
#include "SongbirdConfig.h"

// =============================================================================
// Environment Variable Names
// =============================================================================

#define ENV_MODE                    "mode"
#define ENV_GPS_INTERVAL_MIN        "gps_interval_min"
#define ENV_SYNC_INTERVAL_MIN       "sync_interval_min"
#define ENV_HEARTBEAT_HOURS         "heartbeat_hours"
#define ENV_TEMP_ALERT_HIGH_C       "temp_alert_high_c"
#define ENV_TEMP_ALERT_LOW_C        "temp_alert_low_c"
#define ENV_HUMIDITY_ALERT_HIGH     "humidity_alert_high"
#define ENV_HUMIDITY_ALERT_LOW      "humidity_alert_low"
#define ENV_PRESSURE_ALERT_DELTA    "pressure_alert_delta"
#define ENV_VOLTAGE_ALERT_LOW       "voltage_alert_low"
#define ENV_MOTION_SENSITIVITY      "motion_sensitivity"
#define ENV_MOTION_WAKE_ENABLED     "motion_wake_enabled"
#define ENV_AUDIO_ENABLED           "audio_enabled"
#define ENV_AUDIO_VOLUME            "audio_volume"
#define ENV_AUDIO_ALERTS_ONLY       "audio_alerts_only"
#define ENV_CMD_WAKE_ENABLED        "cmd_wake_enabled"
#define ENV_CMD_ACK_ENABLED         "cmd_ack_enabled"
#define ENV_LOCATE_DURATION_SEC     "locate_duration_sec"
#define ENV_LED_ENABLED             "led_enabled"
#define ENV_DEBUG_MODE              "debug_mode"

// GPS Power Management (Transit Mode)
#define ENV_GPS_POWER_SAVE_ENABLED  "gps_power_save_enabled"
#define ENV_GPS_SIGNAL_TIMEOUT_MIN  "gps_signal_timeout_min"
#define ENV_GPS_RETRY_INTERVAL_MIN  "gps_retry_interval_min"

// =============================================================================
// Environment Module Interface
// =============================================================================

/**
 * @brief Initialize environment module with default configuration
 *
 * @param config Pointer to configuration structure to initialize
 */
void envInitDefaults(SongbirdConfig* config);

/**
 * @brief Fetch all environment variables and update configuration
 *
 * Reads all environment variables from Notehub and populates
 * the configuration structure. Caller must hold I2C mutex.
 *
 * @param config Pointer to configuration structure to update
 * @return true if at least some variables were read successfully
 */
bool envFetchConfig(SongbirdConfig* config);

/**
 * @brief Check if environment variables have been modified
 *
 * Caller must hold I2C mutex.
 *
 * @return true if variables have changed since last fetch
 */
bool envCheckModified(void);

/**
 * @brief Compare two configurations for differences
 *
 * @param a First configuration
 * @param b Second configuration
 * @return true if configurations are different
 */
bool envConfigChanged(const SongbirdConfig* a, const SongbirdConfig* b);

/**
 * @brief Apply mode preset values to configuration
 *
 * Updates timing-related config values based on mode presets.
 * Does not fetch from Notehub - just applies preset values.
 *
 * @param config Configuration to update
 * @param mode Mode to apply
 */
void envApplyModePreset(SongbirdConfig* config, OperatingMode mode);

/**
 * @brief Get sensor read interval for current mode (ms)
 *
 * @param config Current configuration
 * @return Interval in milliseconds
 */
uint32_t envGetSensorIntervalMs(const SongbirdConfig* config);

/**
 * @brief Get command poll interval for current mode (ms)
 *
 * @param config Current configuration
 * @return Interval in milliseconds
 */
uint32_t envGetCommandPollIntervalMs(const SongbirdConfig* config);

/**
 * @brief Get sync interval for current mode (ms)
 *
 * @param config Current configuration
 * @return Interval in milliseconds
 */
uint32_t envGetSyncIntervalMs(const SongbirdConfig* config);

/**
 * @brief Get sleep duration for current mode (seconds)
 *
 * @param config Current configuration
 * @return Duration in seconds (0 for no sleep)
 */
uint32_t envGetSleepDurationSec(const SongbirdConfig* config);

/**
 * @brief Parse operating mode from string
 *
 * @param str Mode string ("demo", "transit", "storage", "sleep")
 * @return Corresponding OperatingMode value
 */
OperatingMode envParseMode(const char* str);

/**
 * @brief Get mode name string
 *
 * @param mode Operating mode
 * @return Mode name string
 */
const char* envGetModeName(OperatingMode mode);

/**
 * @brief Parse motion sensitivity from string
 *
 * @param str Sensitivity string ("low", "medium", "high")
 * @return Corresponding MotionSensitivity value
 */
MotionSensitivity envParseSensitivity(const char* str);

/**
 * @brief Log configuration to serial (debug builds only)
 *
 * @param config Configuration to log
 */
void envLogConfig(const SongbirdConfig* config);

/**
 * @brief Log specific configuration changes between old and new config
 *
 * Compares two configurations and logs each field that changed.
 * Always logs to serial so changes are visible during demos.
 *
 * @param oldConfig Previous configuration
 * @param newConfig New configuration
 */
void envLogConfigChanges(const SongbirdConfig* oldConfig, const SongbirdConfig* newConfig);

#endif // SONGBIRD_ENV_H
