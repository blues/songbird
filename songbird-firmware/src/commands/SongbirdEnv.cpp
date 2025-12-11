/**
 * @file SongbirdEnv.cpp
 * @brief Environment variable management implementation
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdEnv.h"
#include "SongbirdNotecard.h"

// =============================================================================
// Initialization
// =============================================================================

void envInitDefaults(SongbirdConfig* config) {
    if (config == NULL) {
        return;
    }

    config->mode = DEFAULT_MODE;
    config->gpsIntervalMin = DEFAULT_GPS_INTERVAL_MIN;
    config->syncIntervalMin = DEFAULT_SYNC_INTERVAL_MIN;
    config->heartbeatHours = DEFAULT_HEARTBEAT_HOURS;

    config->tempAlertHighC = DEFAULT_TEMP_ALERT_HIGH_C;
    config->tempAlertLowC = DEFAULT_TEMP_ALERT_LOW_C;
    config->humidityAlertHigh = DEFAULT_HUMIDITY_ALERT_HIGH;
    config->humidityAlertLow = DEFAULT_HUMIDITY_ALERT_LOW;
    config->pressureAlertDelta = DEFAULT_PRESSURE_ALERT_DELTA;
    config->voltageAlertLow = DEFAULT_VOLTAGE_ALERT_LOW;

    config->motionSensitivity = DEFAULT_MOTION_SENSITIVITY;
    config->motionWakeEnabled = DEFAULT_MOTION_WAKE_ENABLED;

    config->audioEnabled = DEFAULT_AUDIO_ENABLED;
    config->audioVolume = DEFAULT_AUDIO_VOLUME;
    config->audioAlertsOnly = DEFAULT_AUDIO_ALERTS_ONLY;

    config->cmdWakeEnabled = DEFAULT_CMD_WAKE_ENABLED;
    config->cmdAckEnabled = DEFAULT_CMD_ACK_ENABLED;
    config->locateDurationSec = DEFAULT_LOCATE_DURATION_SEC;

    config->ledEnabled = DEFAULT_LED_ENABLED;
    config->debugMode = DEFAULT_DEBUG_MODE;
}

// =============================================================================
// Environment Variable Fetching
// =============================================================================

bool envFetchConfig(SongbirdConfig* config) {
    if (config == NULL) {
        return false;
    }

    char buffer[32];
    bool anySuccess = false;

    // Mode
    if (notecardEnvGet(ENV_MODE, buffer, sizeof(buffer))) {
        config->mode = envParseMode(buffer);
        anySuccess = true;
    }

    // Timing
    int32_t intVal;
    intVal = notecardEnvGetInt(ENV_GPS_INTERVAL_MIN, -1);
    if (intVal >= 0) {
        config->gpsIntervalMin = CLAMP(intVal, 1, 1440);
        anySuccess = true;
    }

    intVal = notecardEnvGetInt(ENV_SYNC_INTERVAL_MIN, -1);
    if (intVal >= 0) {
        config->syncIntervalMin = CLAMP(intVal, 1, 1440);
        anySuccess = true;
    }

    intVal = notecardEnvGetInt(ENV_HEARTBEAT_HOURS, -1);
    if (intVal >= 0) {
        config->heartbeatHours = CLAMP(intVal, 1, 168);
        anySuccess = true;
    }

    // Alert thresholds
    float floatVal;
    floatVal = notecardEnvGetFloat(ENV_TEMP_ALERT_HIGH_C, NAN);
    if (!isnan(floatVal)) {
        config->tempAlertHighC = CLAMP(floatVal, -40.0f, 85.0f);
        anySuccess = true;
    }

    floatVal = notecardEnvGetFloat(ENV_TEMP_ALERT_LOW_C, NAN);
    if (!isnan(floatVal)) {
        config->tempAlertLowC = CLAMP(floatVal, -40.0f, 85.0f);
        anySuccess = true;
    }

    floatVal = notecardEnvGetFloat(ENV_HUMIDITY_ALERT_HIGH, NAN);
    if (!isnan(floatVal)) {
        config->humidityAlertHigh = CLAMP(floatVal, 0.0f, 100.0f);
        anySuccess = true;
    }

    floatVal = notecardEnvGetFloat(ENV_HUMIDITY_ALERT_LOW, NAN);
    if (!isnan(floatVal)) {
        config->humidityAlertLow = CLAMP(floatVal, 0.0f, 100.0f);
        anySuccess = true;
    }

    floatVal = notecardEnvGetFloat(ENV_PRESSURE_ALERT_DELTA, NAN);
    if (!isnan(floatVal)) {
        config->pressureAlertDelta = CLAMP(floatVal, 1.0f, 100.0f);
        anySuccess = true;
    }

    floatVal = notecardEnvGetFloat(ENV_VOLTAGE_ALERT_LOW, NAN);
    if (!isnan(floatVal)) {
        config->voltageAlertLow = CLAMP(floatVal, 3.0f, 4.2f);
        anySuccess = true;
    }

    // Motion
    if (notecardEnvGet(ENV_MOTION_SENSITIVITY, buffer, sizeof(buffer))) {
        config->motionSensitivity = envParseSensitivity(buffer);
        anySuccess = true;
    }

    // Boolean values - only update if explicitly set
    if (notecardEnvGet(ENV_MOTION_WAKE_ENABLED, buffer, sizeof(buffer))) {
        config->motionWakeEnabled = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    if (notecardEnvGet(ENV_AUDIO_ENABLED, buffer, sizeof(buffer))) {
        config->audioEnabled = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    intVal = notecardEnvGetInt(ENV_AUDIO_VOLUME, -1);
    if (intVal >= 0) {
        config->audioVolume = CLAMP(intVal, 0, 100);
        anySuccess = true;
    }

    if (notecardEnvGet(ENV_AUDIO_ALERTS_ONLY, buffer, sizeof(buffer))) {
        config->audioAlertsOnly = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    if (notecardEnvGet(ENV_CMD_WAKE_ENABLED, buffer, sizeof(buffer))) {
        config->cmdWakeEnabled = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    if (notecardEnvGet(ENV_CMD_ACK_ENABLED, buffer, sizeof(buffer))) {
        config->cmdAckEnabled = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    intVal = notecardEnvGetInt(ENV_LOCATE_DURATION_SEC, -1);
    if (intVal >= 0) {
        config->locateDurationSec = CLAMP(intVal, 5, 300);
        anySuccess = true;
    }

    if (notecardEnvGet(ENV_LED_ENABLED, buffer, sizeof(buffer))) {
        config->ledEnabled = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    if (notecardEnvGet(ENV_DEBUG_MODE, buffer, sizeof(buffer))) {
        config->debugMode = (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
        anySuccess = true;
    }

    return anySuccess;
}

bool envCheckModified(void) {
    return notecardEnvModified();
}

// =============================================================================
// Configuration Comparison
// =============================================================================

bool envConfigChanged(const SongbirdConfig* a, const SongbirdConfig* b) {
    if (a == NULL || b == NULL) {
        return true;
    }

    // Compare all fields
    if (a->mode != b->mode) return true;
    if (a->gpsIntervalMin != b->gpsIntervalMin) return true;
    if (a->syncIntervalMin != b->syncIntervalMin) return true;
    if (a->heartbeatHours != b->heartbeatHours) return true;

    if (a->tempAlertHighC != b->tempAlertHighC) return true;
    if (a->tempAlertLowC != b->tempAlertLowC) return true;
    if (a->humidityAlertHigh != b->humidityAlertHigh) return true;
    if (a->humidityAlertLow != b->humidityAlertLow) return true;
    if (a->pressureAlertDelta != b->pressureAlertDelta) return true;
    if (a->voltageAlertLow != b->voltageAlertLow) return true;

    if (a->motionSensitivity != b->motionSensitivity) return true;
    if (a->motionWakeEnabled != b->motionWakeEnabled) return true;

    if (a->audioEnabled != b->audioEnabled) return true;
    if (a->audioVolume != b->audioVolume) return true;
    if (a->audioAlertsOnly != b->audioAlertsOnly) return true;

    if (a->cmdWakeEnabled != b->cmdWakeEnabled) return true;
    if (a->cmdAckEnabled != b->cmdAckEnabled) return true;
    if (a->locateDurationSec != b->locateDurationSec) return true;

    if (a->ledEnabled != b->ledEnabled) return true;
    if (a->debugMode != b->debugMode) return true;

    return false;
}

// =============================================================================
// Mode Presets
// =============================================================================

void envApplyModePreset(SongbirdConfig* config, OperatingMode mode) {
    if (config == NULL) {
        return;
    }

    config->mode = mode;

    switch (mode) {
        case MODE_DEMO:
            config->gpsIntervalMin = 1;
            config->syncIntervalMin = 1;  // Continuous sync
            config->motionSensitivity = MOTION_SENSITIVITY_HIGH;
            break;

        case MODE_TRANSIT:
            config->gpsIntervalMin = 5;
            config->syncIntervalMin = 15;
            config->motionSensitivity = MOTION_SENSITIVITY_MEDIUM;
            break;

        case MODE_STORAGE:
            config->gpsIntervalMin = 60;
            config->syncIntervalMin = 60;
            config->motionSensitivity = MOTION_SENSITIVITY_LOW;
            break;

        case MODE_SLEEP:
            config->gpsIntervalMin = 0;  // Disabled
            config->syncIntervalMin = 0;  // On motion only
            config->motionSensitivity = MOTION_SENSITIVITY_MEDIUM;
            config->motionWakeEnabled = true;
            break;
    }
}

// =============================================================================
// Interval Calculations
// =============================================================================

uint32_t envGetSensorIntervalMs(const SongbirdConfig* config) {
    if (config == NULL) {
        return SENSOR_INTERVAL_DEMO_MS;
    }

    switch (config->mode) {
        case MODE_DEMO:
            return SENSOR_INTERVAL_DEMO_MS;
        case MODE_TRANSIT:
            return SENSOR_INTERVAL_TRANSIT_MS;
        case MODE_STORAGE:
            return SENSOR_INTERVAL_STORAGE_MS;
        case MODE_SLEEP:
            return SENSOR_INTERVAL_SLEEP_MS;
        default:
            return SENSOR_INTERVAL_DEMO_MS;
    }
}

uint32_t envGetCommandPollIntervalMs(const SongbirdConfig* config) {
    if (config == NULL) {
        return COMMAND_POLL_DEMO_MS;
    }

    switch (config->mode) {
        case MODE_DEMO:
            return COMMAND_POLL_DEMO_MS;
        case MODE_TRANSIT:
            return COMMAND_POLL_TRANSIT_MS;
        case MODE_STORAGE:
            return COMMAND_POLL_STORAGE_MS;
        case MODE_SLEEP:
            return COMMAND_POLL_SLEEP_MS;
        default:
            return COMMAND_POLL_DEMO_MS;
    }
}

uint32_t envGetSyncIntervalMs(const SongbirdConfig* config) {
    if (config == NULL) {
        return MINUTES_TO_MS(DEFAULT_SYNC_INTERVAL_MIN);
    }

    return MINUTES_TO_MS(config->syncIntervalMin);
}

uint32_t envGetSleepDurationSec(const SongbirdConfig* config) {
    if (config == NULL) {
        return 0;
    }

    switch (config->mode) {
        case MODE_DEMO:
            return 0;  // No sleep in demo mode
        case MODE_TRANSIT:
            return config->gpsIntervalMin * 60;
        case MODE_STORAGE:
            return config->gpsIntervalMin * 60;
        case MODE_SLEEP:
            return 0;  // Wake on motion only
        default:
            return 0;
    }
}

// =============================================================================
// String Parsing
// =============================================================================

OperatingMode envParseMode(const char* str) {
    if (str == NULL) {
        return DEFAULT_MODE;
    }

    if (strcmp(str, "demo") == 0) {
        return MODE_DEMO;
    } else if (strcmp(str, "transit") == 0) {
        return MODE_TRANSIT;
    } else if (strcmp(str, "storage") == 0) {
        return MODE_STORAGE;
    } else if (strcmp(str, "sleep") == 0) {
        return MODE_SLEEP;
    }

    return DEFAULT_MODE;
}

const char* envGetModeName(OperatingMode mode) {
    switch (mode) {
        case MODE_DEMO:
            return "demo";
        case MODE_TRANSIT:
            return "transit";
        case MODE_STORAGE:
            return "storage";
        case MODE_SLEEP:
            return "sleep";
        default:
            return "unknown";
    }
}

MotionSensitivity envParseSensitivity(const char* str) {
    if (str == NULL) {
        return DEFAULT_MOTION_SENSITIVITY;
    }

    if (strcmp(str, "low") == 0) {
        return MOTION_SENSITIVITY_LOW;
    } else if (strcmp(str, "medium") == 0) {
        return MOTION_SENSITIVITY_MEDIUM;
    } else if (strcmp(str, "high") == 0) {
        return MOTION_SENSITIVITY_HIGH;
    }

    return DEFAULT_MOTION_SENSITIVITY;
}

// =============================================================================
// Debug Logging
// =============================================================================

void envLogConfig(const SongbirdConfig* config) {
    #ifdef DEBUG_MODE
    if (config == NULL) {
        Serial.println("[Env] Config is NULL");
        return;
    }

    Serial.println("[Env] Current Configuration:");
    Serial.print("  Mode: ");
    Serial.println(envGetModeName(config->mode));
    Serial.print("  GPS Interval: ");
    Serial.print(config->gpsIntervalMin);
    Serial.println(" min");
    Serial.print("  Sync Interval: ");
    Serial.print(config->syncIntervalMin);
    Serial.println(" min");
    Serial.print("  Heartbeat: ");
    Serial.print(config->heartbeatHours);
    Serial.println(" hrs");

    Serial.print("  Temp Alert: ");
    Serial.print(config->tempAlertLowC);
    Serial.print(" - ");
    Serial.print(config->tempAlertHighC);
    Serial.println(" C");
    Serial.print("  Humidity Alert: ");
    Serial.print(config->humidityAlertLow);
    Serial.print(" - ");
    Serial.print(config->humidityAlertHigh);
    Serial.println(" %");
    Serial.print("  Pressure Delta: ");
    Serial.print(config->pressureAlertDelta);
    Serial.println(" hPa");
    Serial.print("  Voltage Alert: ");
    Serial.print(config->voltageAlertLow);
    Serial.println(" V");

    Serial.print("  Audio: ");
    Serial.print(config->audioEnabled ? "ON" : "OFF");
    Serial.print(" Vol:");
    Serial.print(config->audioVolume);
    Serial.print(" AlertsOnly:");
    Serial.println(config->audioAlertsOnly ? "Yes" : "No");

    Serial.print("  Motion Wake: ");
    Serial.println(config->motionWakeEnabled ? "Yes" : "No");
    Serial.print("  Cmd Wake: ");
    Serial.println(config->cmdWakeEnabled ? "Yes" : "No");
    Serial.print("  Debug: ");
    Serial.println(config->debugMode ? "Yes" : "No");
    #else
    (void)config;
    #endif
}
