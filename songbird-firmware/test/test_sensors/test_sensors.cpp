/**
 * @file test_sensors.cpp
 * @brief Unit tests for sensor alert-checking logic
 *
 * sensorsCheckAlerts() and sensorsCheckAlertsCleared() are the firmware
 * implementations in SongbirdSensorAlerts.h. sensorsBuildAlert() still
 * lives in SongbirdSensors.cpp next to the BME280 driver, so its body is
 * copied here.
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"
#include "SongbirdSensorAlerts.h"

// ============================================================================
// Copied sensorsBuildAlert from SongbirdSensors.cpp (no HW deps)
// ============================================================================

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
// Humidity rate limit
//
// Replays the SensorTask order: check, record the note time when
// humidity_high fires, then clear using the pre-update flag mask.
// ============================================================================

struct HumiditySample {
    uint32_t timeMs;
    float humidity;
};

static int replay_humidity(const HumiditySample* samples, int count) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    bool haveNote = false;
    uint32_t noteMs = 0;
    uint8_t flags = 0;
    int alerts = 0;

    for (int i = 0; i < count; i++) {
        data.humidity = samples[i].humidity;
        uint8_t raised = sensorsCheckAlerts(&data, &cfg, data.pressure, flags,
                                            haveNote, samples[i].timeMs, noteMs);
        if (raised & ALERT_FLAG_HUMIDITY_HIGH) {
            alerts++;
            haveNote = true;
            noteMs = samples[i].timeMs;
        }
        uint8_t cleared = sensorsCheckAlertsCleared(&data, &cfg, flags);
        flags = (uint8_t)((flags | raised) & ~cleared);
    }
    return alerts;
}

void test_default_humidity_alert_high_is_80(void) {
    TEST_ASSERT_TRUE(DEFAULT_HUMIDITY_ALERT_HIGH == 80.0f);
    SongbirdConfig cfg = make_default_config();
    TEST_ASSERT_TRUE(cfg.humidityAlertHigh == 80.0f);
    TEST_ASSERT_TRUE(SENSOR_HUMIDITY_ALERT_CLEAR_MARGIN_PCT == 5.0f);
    // Quiet interval must outlast a demo sample, and the clear margin must
    // stay below the trip point so 80% is still the threshold.
    TEST_ASSERT_TRUE(SENSOR_HUMIDITY_ALERT_COOLDOWN_MS >= SENSOR_INTERVAL_DEMO_MS);
    TEST_ASSERT_TRUE(SENSOR_HUMIDITY_ALERT_CLEAR_MARGIN_PCT < DEFAULT_HUMIDITY_ALERT_HIGH);

    SensorData data = make_valid_sensor_data();
    data.humidity = DEFAULT_HUMIDITY_ALERT_HIGH;
    uint8_t atThreshold = sensorsCheckAlerts(&data, &cfg, data.pressure, 0);
    TEST_ASSERT_EQUAL_UINT8(0, atThreshold & ALERT_FLAG_HUMIDITY_HIGH);

    data.humidity = DEFAULT_HUMIDITY_ALERT_HIGH + 0.1f;
    uint8_t justOver = sensorsCheckAlerts(&data, &cfg, data.pressure, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_HUMIDITY_HIGH, ALERT_FLAG_HUMIDITY_HIGH, justOver);
}

void test_humidity_high_clears_only_below_margin(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    // 80 - 5 = 75. 76 stays latched; 74 releases.
    data.humidity = 76.0f;
    uint8_t held = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_HUMIDITY_HIGH);
    TEST_ASSERT_EQUAL_UINT8(0, held & ALERT_FLAG_HUMIDITY_HIGH);

    data.humidity = 74.0f;
    uint8_t released = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_HUMIDITY_HIGH);
    TEST_ASSERT_BITS(ALERT_FLAG_HUMIDITY_HIGH, ALERT_FLAG_HUMIDITY_HIGH, released);
}

void test_humidity_high_cooldown_survives_millis_wrap(void) {
    const uint32_t lastNoteMs = UINT32_MAX - 1000u;
    const uint32_t nowMs = 1000u;
    uint32_t elapsed = nowMs - lastNoteMs;

    TEST_ASSERT_TRUE(elapsed == 2001u);
    TEST_ASSERT_TRUE(elapsed < SENSOR_HUMIDITY_ALERT_COOLDOWN_MS);
    TEST_ASSERT_TRUE(humidityHighCoolingDown(true, nowMs, lastNoteMs));

    uint32_t later = nowMs + SENSOR_HUMIDITY_ALERT_COOLDOWN_MS;
    TEST_ASSERT_FALSE(humidityHighCoolingDown(true, later, lastNoteMs));
    TEST_ASSERT_FALSE(humidityHighCoolingDown(false, nowMs, lastNoteMs));
}

void test_stuck_humidity_alerts_once_across_three_windows(void) {
    // songbird-14's stuck alert_value, held with no dip below the clear
    // margin. The latch alone makes this one note; the quiet interval must
    // not turn it into one note per window.
    const uint32_t stepMs = SENSOR_INTERVAL_DEMO_MS;
    const int windows = 3;
    int count = (int)((SENSOR_HUMIDITY_ALERT_COOLDOWN_MS / stepMs) * windows);
    TEST_ASSERT_TRUE(count > windows);
    TEST_ASSERT_TRUE(count < 512);

    HumiditySample samples[512];
    for (int i = 0; i < count; i++) {
        samples[i].timeMs = (uint32_t)(i + 1) * stepMs;
        samples[i].humidity = 92.28906f;
    }
    TEST_ASSERT_EQUAL_INT(1, replay_humidity(samples, count));
}

void test_songbird14_humidity_sequence_is_rate_limited(void) {
    // dev:868531061584319 on 2026-09-01, 17:21–17:52 UTC. Real ~36% RH
    // samples bracket the compensated BME280 reset value 92.289% RH.
    // Times are milliseconds from 17:21:26. Three spikes inside 30 minutes
    // used to emit three humidity_high notes because each real sample
    // cleared the latch.
    const uint32_t cooldown = SENSOR_HUMIDITY_ALERT_COOLDOWN_MS;
    HumiditySample samples[] = {
        {0, 36.612f},
        {397000, 92.28906f},
        {955000, 36.586f},
        {1111000, 92.28906f},
        {1211000, 36.643f},
        {1530000, 92.28906f},
        {1605000, 36.471f},
        // Quiet interval opened by the 92.289 sample at 397s has elapsed,
        // the latch is clear, and the same value crosses again.
        {397000 + cooldown, 36.471f},
        {397000 + cooldown + 60000, 92.28906f},
    };
    int count = (int)(sizeof(samples) / sizeof(samples[0]));

    TEST_ASSERT_EQUAL_INT(2, replay_humidity(samples, count));

    // The same three spikes with no sample past the quiet interval.
    TEST_ASSERT_EQUAL_INT(1, replay_humidity(samples, count - 2));
}

void test_humidity_rearms_after_clear_below_75_and_quiet_interval(void) {
    const uint32_t step = SENSOR_INTERVAL_DEMO_MS;
    const uint32_t cooldown = SENSOR_HUMIDITY_ALERT_COOLDOWN_MS;
    // A real 85% crossing, a real clear below 75%, another crossing inside
    // the quiet interval, then the same crossing once the interval has
    // elapsed. Threshold stays 80; 85 is not a power-on constant.
    HumiditySample samples[] = {
        {step, 85.0f},
        {step * 2, 74.0f},
        {step * 3, 85.0f},
        {step + cooldown, 74.0f},
        {step + cooldown + step, 85.0f},
    };
    TEST_ASSERT_EQUAL_INT(2, replay_humidity(samples, 5));
    // Inside the quiet interval the second crossing does not alert.
    TEST_ASSERT_EQUAL_INT(1, replay_humidity(samples, 3));
}

void test_humidity_high_note_threshold_stays_80(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    data.humidity = 92.28906f;
    Alert alert;

    sensorsBuildAlert(ALERT_FLAG_HUMIDITY_HIGH, &data, &cfg, &alert);

    TEST_ASSERT_EQUAL_STRING(ALERT_TYPE_HUMIDITY_HIGH, alert.type);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 92.28906f, alert.value);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 80.0f, alert.threshold);
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

    // humidity_high rate limit
    RUN_TEST(test_default_humidity_alert_high_is_80);
    RUN_TEST(test_humidity_high_clears_only_below_margin);
    RUN_TEST(test_humidity_high_cooldown_survives_millis_wrap);
    RUN_TEST(test_stuck_humidity_alerts_once_across_three_windows);
    RUN_TEST(test_songbird14_humidity_sequence_is_rate_limited);
    RUN_TEST(test_humidity_rearms_after_clear_below_75_and_quiet_interval);
    RUN_TEST(test_humidity_high_note_threshold_stays_80);

    // sensorsBuildAlert
    RUN_TEST(test_build_alert_temp_high);
    RUN_TEST(test_build_alert_low_battery);
    RUN_TEST(test_build_alert_unknown_flag);
    RUN_TEST(test_build_alert_returns_early_when_alert_null);

    return UNITY_END();
}
