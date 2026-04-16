/**
 * @file test_sensors.cpp
 * @brief Unit tests for sensor alert-checking logic
 *
 * Tests the pure-logic alert functions from SongbirdSensors.cpp:
 *   - sensorsCheckAlerts()
 *   - sensorsCheckAlertsCleared()
 *   - sensorsBuildAlert()
 *
 * These functions are copied here because SongbirdSensors.cpp includes
 * hardware headers (Wire.h, Adafruit_BME280.h) that cannot compile natively.
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"

// ============================================================================
// Copied alert functions from SongbirdSensors.cpp (pure logic, no HW deps)
// ============================================================================

static uint8_t sensorsCheckAlerts(const SensorData* data,
                                  const SongbirdConfig* config,
                                  float previousPressure,
                                  uint8_t currentAlerts) {
    if (data == NULL || config == NULL || !data->valid) {
        return 0;
    }

    uint8_t newAlerts = 0;

    // Temperature high
    if (!(currentAlerts & ALERT_FLAG_TEMP_HIGH) &&
        data->temperature > config->tempAlertHighC) {
        newAlerts |= ALERT_FLAG_TEMP_HIGH;
    }

    // Temperature low
    if (!(currentAlerts & ALERT_FLAG_TEMP_LOW) &&
        data->temperature < config->tempAlertLowC) {
        newAlerts |= ALERT_FLAG_TEMP_LOW;
    }

    // Humidity high
    if (!(currentAlerts & ALERT_FLAG_HUMIDITY_HIGH) &&
        data->humidity > config->humidityAlertHigh) {
        newAlerts |= ALERT_FLAG_HUMIDITY_HIGH;
    }

    // Humidity low
    if (!(currentAlerts & ALERT_FLAG_HUMIDITY_LOW) &&
        data->humidity < config->humidityAlertLow) {
        newAlerts |= ALERT_FLAG_HUMIDITY_LOW;
    }

    // Pressure delta (only if we have a previous reading)
    if (!(currentAlerts & ALERT_FLAG_PRESSURE_DELTA) &&
        !isnan(previousPressure) && previousPressure > 0) {
        float delta = fabs(data->pressure - previousPressure);
        if (delta > config->pressureAlertDelta) {
            newAlerts |= ALERT_FLAG_PRESSURE_DELTA;
        }
    }

    // Low battery
    if (!(currentAlerts & ALERT_FLAG_LOW_BATTERY) &&
        data->voltage > 0 && data->voltage < config->voltageAlertLow) {
        newAlerts |= ALERT_FLAG_LOW_BATTERY;
    }

    return newAlerts;
}

static uint8_t sensorsCheckAlertsCleared(const SensorData* data,
                                          const SongbirdConfig* config,
                                          uint8_t currentAlerts) {
    if (data == NULL || config == NULL || !data->valid) {
        return 0;
    }

    uint8_t clearedAlerts = 0;

    // Temperature high cleared (with hysteresis)
    if ((currentAlerts & ALERT_FLAG_TEMP_HIGH) &&
        data->temperature < (config->tempAlertHighC - 2.0f)) {
        clearedAlerts |= ALERT_FLAG_TEMP_HIGH;
    }

    // Temperature low cleared (with hysteresis)
    if ((currentAlerts & ALERT_FLAG_TEMP_LOW) &&
        data->temperature > (config->tempAlertLowC + 2.0f)) {
        clearedAlerts |= ALERT_FLAG_TEMP_LOW;
    }

    // Humidity high cleared
    if ((currentAlerts & ALERT_FLAG_HUMIDITY_HIGH) &&
        data->humidity < (config->humidityAlertHigh - 5.0f)) {
        clearedAlerts |= ALERT_FLAG_HUMIDITY_HIGH;
    }

    // Humidity low cleared
    if ((currentAlerts & ALERT_FLAG_HUMIDITY_LOW) &&
        data->humidity > (config->humidityAlertLow + 5.0f)) {
        clearedAlerts |= ALERT_FLAG_HUMIDITY_LOW;
    }

    // Pressure delta always clears (transient event)
    if (currentAlerts & ALERT_FLAG_PRESSURE_DELTA) {
        clearedAlerts |= ALERT_FLAG_PRESSURE_DELTA;
    }

    // Low battery cleared (with hysteresis)
    if ((currentAlerts & ALERT_FLAG_LOW_BATTERY) &&
        data->voltage > (config->voltageAlertLow + 0.1f)) {
        clearedAlerts |= ALERT_FLAG_LOW_BATTERY;
    }

    return clearedAlerts;
}

static void sensorsBuildAlert(uint8_t alertFlag,
                              const SensorData* data,
                              const SongbirdConfig* config,
                              Alert* alert) {
    if (alert == NULL || data == NULL || config == NULL) {
        return;
    }

    memset(alert, 0, sizeof(Alert));

    switch (alertFlag) {
        case ALERT_FLAG_TEMP_HIGH:
            alert->type = ALERT_TYPE_TEMP_HIGH;
            alert->value = data->temperature;
            alert->threshold = config->tempAlertHighC;
            snprintf(alert->message, sizeof(alert->message),
                     "Temperature %.1fC exceeds %.1fC threshold",
                     data->temperature, config->tempAlertHighC);
            break;

        case ALERT_FLAG_TEMP_LOW:
            alert->type = ALERT_TYPE_TEMP_LOW;
            alert->value = data->temperature;
            alert->threshold = config->tempAlertLowC;
            snprintf(alert->message, sizeof(alert->message),
                     "Temperature %.1fC below %.1fC threshold",
                     data->temperature, config->tempAlertLowC);
            break;

        case ALERT_FLAG_HUMIDITY_HIGH:
            alert->type = ALERT_TYPE_HUMIDITY_HIGH;
            alert->value = data->humidity;
            alert->threshold = config->humidityAlertHigh;
            snprintf(alert->message, sizeof(alert->message),
                     "Humidity %.1f%% exceeds %.1f%% threshold",
                     data->humidity, config->humidityAlertHigh);
            break;

        case ALERT_FLAG_HUMIDITY_LOW:
            alert->type = ALERT_TYPE_HUMIDITY_LOW;
            alert->value = data->humidity;
            alert->threshold = config->humidityAlertLow;
            snprintf(alert->message, sizeof(alert->message),
                     "Humidity %.1f%% below %.1f%% threshold",
                     data->humidity, config->humidityAlertLow);
            break;

        case ALERT_FLAG_PRESSURE_DELTA:
            alert->type = ALERT_TYPE_PRESSURE_DELTA;
            alert->value = data->pressure;
            alert->threshold = config->pressureAlertDelta;
            snprintf(alert->message, sizeof(alert->message),
                     "Pressure changed significantly to %.1f hPa",
                     data->pressure);
            break;

        case ALERT_FLAG_LOW_BATTERY:
            alert->type = ALERT_TYPE_LOW_BATTERY;
            alert->value = data->voltage;
            alert->threshold = config->voltageAlertLow;
            snprintf(alert->message, sizeof(alert->message),
                     "Battery voltage low. Charge now.");
            break;

        default:
            alert->type = "unknown";
            snprintf(alert->message, sizeof(alert->message), "Unknown alert");
            break;
    }
}

// ============================================================================
// Test Helpers
// ============================================================================

static SongbirdConfig make_default_config(void) {
    SongbirdConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.mode = DEFAULT_MODE;
    cfg.gpsIntervalMin = DEFAULT_GPS_INTERVAL_MIN;
    cfg.syncIntervalMin = DEFAULT_SYNC_INTERVAL_MIN;
    cfg.heartbeatHours = DEFAULT_HEARTBEAT_HOURS;
    cfg.tempAlertHighC = DEFAULT_TEMP_ALERT_HIGH_C;
    cfg.tempAlertLowC = DEFAULT_TEMP_ALERT_LOW_C;
    cfg.humidityAlertHigh = DEFAULT_HUMIDITY_ALERT_HIGH;
    cfg.humidityAlertLow = DEFAULT_HUMIDITY_ALERT_LOW;
    cfg.pressureAlertDelta = DEFAULT_PRESSURE_ALERT_DELTA;
    cfg.voltageAlertLow = DEFAULT_VOLTAGE_ALERT_LOW;
    cfg.motionSensitivity = DEFAULT_MOTION_SENSITIVITY;
    cfg.motionWakeEnabled = DEFAULT_MOTION_WAKE_ENABLED;
    cfg.audioEnabled = DEFAULT_AUDIO_ENABLED;
    cfg.audioVolume = DEFAULT_AUDIO_VOLUME;
    cfg.audioAlertsOnly = DEFAULT_AUDIO_ALERTS_ONLY;
    cfg.cmdWakeEnabled = DEFAULT_CMD_WAKE_ENABLED;
    cfg.cmdAckEnabled = DEFAULT_CMD_ACK_ENABLED;
    cfg.locateDurationSec = DEFAULT_LOCATE_DURATION_SEC;
    cfg.ledEnabled = DEFAULT_LED_ENABLED;
    cfg.debugMode = DEFAULT_DEBUG_MODE;
    cfg.gpsPowerSaveEnabled = DEFAULT_GPS_POWER_SAVE_ENABLED;
    cfg.gpsSignalTimeoutMin = DEFAULT_GPS_SIGNAL_TIMEOUT_MIN;
    cfg.gpsRetryIntervalMin = DEFAULT_GPS_RETRY_INTERVAL_MIN;
    return cfg;
}

static SensorData make_valid_sensor_data(void) {
    SensorData data;
    memset(&data, 0, sizeof(data));
    data.temperature = 22.0f;   // Normal room temperature
    data.humidity = 45.0f;      // Normal humidity
    data.pressure = 1013.25f;   // Standard atmospheric pressure
    data.voltage = 4.1f;        // Healthy battery
    data.motion = false;
    data.valid = true;
    data.timestamp = 1700000000;
    return data;
}

void setUp(void) {}
void tearDown(void) {}

// ============================================================================
// sensorsCheckAlerts Tests
// ============================================================================

void test_check_alerts_returns_zero_when_data_null(void) {
    SongbirdConfig cfg = make_default_config();
    uint8_t result = sensorsCheckAlerts(NULL, &cfg, 1013.0f, 0);
    TEST_ASSERT_EQUAL_UINT8(0, result);
}

void test_check_alerts_returns_zero_when_data_invalid(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.valid = false;
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_EQUAL_UINT8(0, result);
}

void test_check_alerts_detects_temp_high(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.temperature = 36.0f;  // Above default threshold of 35C
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_TEMP_HIGH, ALERT_FLAG_TEMP_HIGH, result);
}

void test_check_alerts_detects_temp_low(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.temperature = -1.0f;  // Below default threshold of 0C
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_TEMP_LOW, ALERT_FLAG_TEMP_LOW, result);
}

void test_check_alerts_detects_humidity_high(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.humidity = 85.0f;  // Above default threshold of 80%
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_HUMIDITY_HIGH, ALERT_FLAG_HUMIDITY_HIGH, result);
}

void test_check_alerts_detects_humidity_low(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.humidity = 15.0f;  // Below default threshold of 20%
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_HUMIDITY_LOW, ALERT_FLAG_HUMIDITY_LOW, result);
}

void test_check_alerts_detects_pressure_delta(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.pressure = 1030.0f;  // 16.75 hPa change from previous 1013.25
    float previousPressure = 1013.25f;
    uint8_t result = sensorsCheckAlerts(&data, &cfg, previousPressure, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_PRESSURE_DELTA, ALERT_FLAG_PRESSURE_DELTA, result);
}

void test_check_alerts_detects_low_battery(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.voltage = 3.2f;  // Below default threshold of 3.4V
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_LOW_BATTERY, ALERT_FLAG_LOW_BATTERY, result);
}

void test_check_alerts_does_not_retrigger_active_alert(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.temperature = 36.0f;  // Above threshold
    // ALERT_FLAG_TEMP_HIGH already active
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_EQUAL_UINT8(0, result & ALERT_FLAG_TEMP_HIGH);
}

void test_check_alerts_returns_multiple_flags(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.temperature = 36.0f;  // Temp high
    data.humidity = 85.0f;     // Humidity high
    data.voltage = 3.2f;       // Low battery
    uint8_t result = sensorsCheckAlerts(&data, &cfg, 1013.0f, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_TEMP_HIGH, ALERT_FLAG_TEMP_HIGH, result);
    TEST_ASSERT_BITS(ALERT_FLAG_HUMIDITY_HIGH, ALERT_FLAG_HUMIDITY_HIGH, result);
    TEST_ASSERT_BITS(ALERT_FLAG_LOW_BATTERY, ALERT_FLAG_LOW_BATTERY, result);
}

// ============================================================================
// sensorsCheckAlertsCleared Tests
// ============================================================================

void test_cleared_returns_zero_when_data_null(void) {
    SongbirdConfig cfg = make_default_config();
    uint8_t result = sensorsCheckAlertsCleared(NULL, &cfg, ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_EQUAL_UINT8(0, result);
}

void test_cleared_temp_high_with_hysteresis(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    // Threshold is 35C, hysteresis is 2C, so must be below 33C to clear
    data.temperature = 32.0f;
    uint8_t result = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_BITS(ALERT_FLAG_TEMP_HIGH, ALERT_FLAG_TEMP_HIGH, result);
}

void test_cleared_temp_high_not_cleared_without_hysteresis(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    // Threshold is 35C, hysteresis is 2C: temp at 34C is between 33-35, should NOT clear
    data.temperature = 34.0f;
    uint8_t result = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_EQUAL_UINT8(0, result & ALERT_FLAG_TEMP_HIGH);
}

void test_cleared_pressure_delta_always_clears(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    uint8_t result = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_PRESSURE_DELTA);
    TEST_ASSERT_BITS(ALERT_FLAG_PRESSURE_DELTA, ALERT_FLAG_PRESSURE_DELTA, result);
}

void test_cleared_low_battery_with_hysteresis(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    // Threshold is 3.4V, hysteresis is 0.1V, must be above 3.5V to clear
    data.voltage = 3.6f;
    uint8_t result = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_LOW_BATTERY);
    TEST_ASSERT_BITS(ALERT_FLAG_LOW_BATTERY, ALERT_FLAG_LOW_BATTERY, result);
}

// ============================================================================
// sensorsBuildAlert Tests
// ============================================================================

void test_build_alert_temp_high(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.temperature = 37.5f;
    Alert alert;

    sensorsBuildAlert(ALERT_FLAG_TEMP_HIGH, &data, &cfg, &alert);

    TEST_ASSERT_EQUAL_STRING(ALERT_TYPE_TEMP_HIGH, alert.type);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 37.5f, alert.value);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, cfg.tempAlertHighC, alert.threshold);
    TEST_ASSERT_TRUE(strlen(alert.message) > 0);
}

void test_build_alert_low_battery(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.voltage = 3.1f;
    Alert alert;

    sensorsBuildAlert(ALERT_FLAG_LOW_BATTERY, &data, &cfg, &alert);

    TEST_ASSERT_EQUAL_STRING(ALERT_TYPE_LOW_BATTERY, alert.type);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 3.1f, alert.value);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, cfg.voltageAlertLow, alert.threshold);
}

void test_build_alert_unknown_flag(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    Alert alert;

    sensorsBuildAlert(0xFF, &data, &cfg, &alert);

    TEST_ASSERT_EQUAL_STRING("unknown", alert.type);
}

void test_build_alert_returns_early_when_alert_null(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();

    // Should not crash when alert pointer is NULL
    sensorsBuildAlert(ALERT_FLAG_TEMP_HIGH, &data, &cfg, NULL);
    TEST_PASS();
}

// ============================================================================
// Main
// ============================================================================

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // sensorsCheckAlerts
    RUN_TEST(test_check_alerts_returns_zero_when_data_null);
    RUN_TEST(test_check_alerts_returns_zero_when_data_invalid);
    RUN_TEST(test_check_alerts_detects_temp_high);
    RUN_TEST(test_check_alerts_detects_temp_low);
    RUN_TEST(test_check_alerts_detects_humidity_high);
    RUN_TEST(test_check_alerts_detects_humidity_low);
    RUN_TEST(test_check_alerts_detects_pressure_delta);
    RUN_TEST(test_check_alerts_detects_low_battery);
    RUN_TEST(test_check_alerts_does_not_retrigger_active_alert);
    RUN_TEST(test_check_alerts_returns_multiple_flags);

    // sensorsCheckAlertsCleared
    RUN_TEST(test_cleared_returns_zero_when_data_null);
    RUN_TEST(test_cleared_temp_high_with_hysteresis);
    RUN_TEST(test_cleared_temp_high_not_cleared_without_hysteresis);
    RUN_TEST(test_cleared_pressure_delta_always_clears);
    RUN_TEST(test_cleared_low_battery_with_hysteresis);

    // sensorsBuildAlert
    RUN_TEST(test_build_alert_temp_high);
    RUN_TEST(test_build_alert_low_battery);
    RUN_TEST(test_build_alert_unknown_flag);
    RUN_TEST(test_build_alert_returns_early_when_alert_null);

    return UNITY_END();
}
