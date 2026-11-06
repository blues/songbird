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

void test_pressure_latch_releases_when_anchor_missing(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    // No anchor (NaN default): release rather than stick a restored flag
    // that SensorTask can no longer settle against a sample.
    uint8_t result = sensorsCheckAlertsCleared(&data, &cfg, ALERT_FLAG_PRESSURE_DELTA);
    TEST_ASSERT_BITS(ALERT_FLAG_PRESSURE_DELTA, ALERT_FLAG_PRESSURE_DELTA, result);
}

void test_pressure_latch_held_until_settled_after_cooldown(void) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    const float anchor = 1013.25f;

    // Still inside the quiet interval, even back on the alerted sample.
    data.pressure = anchor;
    uint8_t held = sensorsCheckAlertsCleared(
        &data, &cfg, ALERT_FLAG_PRESSURE_DELTA,
        anchor, SENSOR_PRESSURE_ALERT_COOLDOWN_MS / 2, 0);
    TEST_ASSERT_EQUAL_UINT8(0, held & ALERT_FLAG_PRESSURE_DELTA);

    // Cooldown elapsed but the reading is still a long way from the anchor.
    data.pressure = 605.46045f;
    held = sensorsCheckAlertsCleared(
        &data, &cfg, ALERT_FLAG_PRESSURE_DELTA,
        anchor, SENSOR_PRESSURE_ALERT_COOLDOWN_MS, 0);
    TEST_ASSERT_EQUAL_UINT8(0, held & ALERT_FLAG_PRESSURE_DELTA);

    // Settled on the anchor and the interval has elapsed: release.
    data.pressure = anchor;
    uint8_t released = sensorsCheckAlertsCleared(
        &data, &cfg, ALERT_FLAG_PRESSURE_DELTA,
        anchor, SENSOR_PRESSURE_ALERT_COOLDOWN_MS, 0);
    TEST_ASSERT_BITS(ALERT_FLAG_PRESSURE_DELTA, ALERT_FLAG_PRESSURE_DELTA, released);
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
// Pressure rate limit
//
// Replays the SensorTask order: check against the anchor, record the anchor
// when pressure_change fires, then clear using the pre-update flag mask.
// ============================================================================

static int replay_pressure(const float* samples, int count, uint32_t stepMs,
                           float initialPrevious) {
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    float previous = initialPrevious;
    float anchor = NAN;
    uint32_t anchorMs = 0;
    uint8_t flags = 0;
    int alerts = 0;

    for (int i = 0; i < count; i++) {
        uint32_t now = (uint32_t)(i + 1) * stepMs;
        data.pressure = samples[i];
        uint8_t raised = sensorsCheckAlerts(&data, &cfg, previous, flags,
                                            anchor, now, anchorMs);
        if (raised & ALERT_FLAG_PRESSURE_DELTA) {
            alerts++;
            anchor = data.pressure;
            anchorMs = now;
        }
        uint8_t cleared = sensorsCheckAlertsCleared(&data, &cfg, flags,
                                                    anchor, now, anchorMs);
        flags = (uint8_t)((flags | raised) & ~cleared);
        previous = data.pressure;
    }
    return alerts;
}

void test_default_pressure_alert_delta_is_10_hpa(void) {
    TEST_ASSERT_TRUE(DEFAULT_PRESSURE_ALERT_DELTA == 10.0f);
    SongbirdConfig cfg = make_default_config();
    TEST_ASSERT_TRUE(cfg.pressureAlertDelta == 10.0f);
    // The quiet interval and the latch band must not be doing the trip
    // point's job. The 50 hPa plausibility gate stays where it is.
    TEST_ASSERT_TRUE(SENSOR_PRESSURE_ALERT_HYSTERESIS_HPA > 0.0f);
    TEST_ASSERT_TRUE(SENSOR_PRESSURE_ALERT_HYSTERESIS_HPA < DEFAULT_PRESSURE_ALERT_DELTA);
    TEST_ASSERT_TRUE(SENSOR_PRESSURE_ALERT_COOLDOWN_MS >= SENSOR_INTERVAL_DEMO_MS);
    TEST_ASSERT_TRUE(SENSOR_PRESSURE_JUMP_REJECT_HPA == 50.0f);
}

void test_pressure_alert_cooldown_survives_millis_wrap(void) {
    // lastAlert was 1000 ms before the clock wrapped; now is 1000 ms after.
    // Unsigned subtraction yields 2001 ms, still inside the quiet interval.
    const float anchor = 605.46045f;
    const uint32_t lastAlertMs = UINT32_MAX - 1000u;
    const uint32_t nowMs = 1000u;
    uint32_t elapsed = nowMs - lastAlertMs;

    TEST_ASSERT_TRUE(elapsed == 2001u);
    TEST_ASSERT_TRUE(elapsed < SENSOR_PRESSURE_ALERT_COOLDOWN_MS);
    TEST_ASSERT_TRUE(pressureAlertCoolingDown(anchor, nowMs, lastAlertMs));

    // Same wrap, once the quiet interval itself has elapsed.
    uint32_t later = nowMs + SENSOR_PRESSURE_ALERT_COOLDOWN_MS;
    TEST_ASSERT_FALSE(pressureAlertCoolingDown(anchor, later, lastAlertMs));
}

void test_pressure_step_of_exactly_10_hpa_does_not_alert(void) {
    float atThreshold = 1013.25f + DEFAULT_PRESSURE_ALERT_DELTA;
    int alerts = replay_pressure(&atThreshold, 1, SENSOR_INTERVAL_DEMO_MS, 1013.25f);
    TEST_ASSERT_EQUAL_INT(0, alerts);

    float justOver = 1013.25f + DEFAULT_PRESSURE_ALERT_DELTA + 0.1f;
    alerts = replay_pressure(&justOver, 1, SENSOR_INTERVAL_DEMO_MS, 1013.25f);
    TEST_ASSERT_EQUAL_INT(1, alerts);
}

void test_por_band_identical_values_alert_once_across_three_windows(void) {
    // songbird-17's stuck alert_value and songbird-14's, replayed across
    // several quiet intervals at the demo sample period. A constant POR-band
    // reading is one event: one note total, not one per window.
    const uint32_t stepMs = SENSOR_INTERVAL_DEMO_MS;
    const int windows = 3;
    int count = (int)((SENSOR_PRESSURE_ALERT_COOLDOWN_MS / stepMs) * windows);
    TEST_ASSERT_TRUE(count > windows);
    TEST_ASSERT_TRUE(count < 512);

    float samples[512];
    for (int i = 0; i < count; i++) {
        samples[i] = 605.46045f;
    }
    int alerts = replay_pressure(samples, count, stepMs, 1013.25f);
    TEST_ASSERT_EQUAL_INT(1, alerts);

    for (int i = 0; i < count; i++) {
        samples[i] = 748.7944f;
    }
    alerts = replay_pressure(samples, count, stepMs, 1013.25f);
    TEST_ASSERT_EQUAL_INT(1, alerts);
}

void test_pressure_oscillation_is_rate_limited(void) {
    // 14.5 hPa swing: above the 10 hPa trip, inside the 50 hPa gate, so
    // SensorTask would accept every sample. Without a cooldown the old
    // clear-on-next-sample path alerts on every other reading, and every
    // one of those notes carries the same POR value.
    const uint32_t stepMs = SENSOR_INTERVAL_DEMO_MS;
    const int windows = 3;
    int perWindow = (int)(SENSOR_PRESSURE_ALERT_COOLDOWN_MS / stepMs);
    int count = perWindow * windows;
    TEST_ASSERT_TRUE(perWindow >= 4);
    TEST_ASSERT_TRUE(count < 512);

    float samples[512];
    for (int i = 0; i < count; i++) {
        samples[i] = (i % 2 == 0) ? 605.46045f : 620.0f;
    }
    int alerts = replay_pressure(samples, count, stepMs, 1013.25f);
    TEST_ASSERT_TRUE(alerts >= 1);
    TEST_ASSERT_TRUE(alerts <= windows);

    // A single window, strictly inside the quiet interval, is one note.
    int inside = perWindow > 1 ? perWindow - 1 : 1;
    alerts = replay_pressure(samples, inside, stepMs, 1013.25f);
    TEST_ASSERT_EQUAL_INT(1, alerts);
}

void test_genuine_pressure_step_alerts_once(void) {
    const uint32_t stepMs = SENSOR_INTERVAL_DEMO_MS;
    int count = (int)(SENSOR_PRESSURE_ALERT_COOLDOWN_MS / stepMs) + 4;
    TEST_ASSERT_TRUE(count < 512);
    TEST_ASSERT_TRUE(count > 4);

    float samples[512];
    // Just over 10 hPa from 1013.25, then held. One physical step.
    samples[0] = 1013.25f + DEFAULT_PRESSURE_ALERT_DELTA + 0.5f;
    for (int i = 1; i < count; i++) {
        samples[i] = samples[0];
    }
    int alerts = replay_pressure(samples, count, stepMs, 1013.25f);
    TEST_ASSERT_EQUAL_INT(1, alerts);
}

void test_second_pressure_step_waits_for_cooldown(void) {
    const uint32_t stepMs = SENSOR_INTERVAL_DEMO_MS;
    float first = 1013.25f + 12.0f;
    float second = first + 12.0f;
    float samples[4];
    samples[0] = first;
    samples[1] = second;
    samples[2] = second;
    samples[3] = second;

    // Samples land at step, 2*step, cooldown, and cooldown+step. The second
    // step is visible the whole time but must not note until the quiet
    // interval opened by the first step has elapsed.
    // replay_pressure uses (i+1)*stepMs, so build the series by hand.
    SongbirdConfig cfg = make_default_config();
    SensorData data = make_valid_sensor_data();
    float previous = 1013.25f;
    float anchor = NAN;
    uint32_t anchorMs = 0;
    uint8_t flags = 0;
    int alerts = 0;
    uint32_t times[4] = {
        stepMs,
        stepMs * 2,
        stepMs + SENSOR_PRESSURE_ALERT_COOLDOWN_MS,
        stepMs + SENSOR_PRESSURE_ALERT_COOLDOWN_MS + stepMs
    };

    for (int i = 0; i < 4; i++) {
        data.pressure = samples[i];
        uint8_t raised = sensorsCheckAlerts(&data, &cfg, previous, flags,
                                            anchor, times[i], anchorMs);
        if (raised & ALERT_FLAG_PRESSURE_DELTA) {
            alerts++;
            anchor = data.pressure;
            anchorMs = times[i];
        }
        uint8_t cleared = sensorsCheckAlertsCleared(&data, &cfg, flags,
                                                    anchor, times[i], anchorMs);
        flags = (uint8_t)((flags | raised) & ~cleared);
        previous = data.pressure;
    }

    TEST_ASSERT_EQUAL_INT(2, alerts);
    TEST_ASSERT_TRUE(anchor == second);
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
    RUN_TEST(test_pressure_latch_releases_when_anchor_missing);
    RUN_TEST(test_pressure_latch_held_until_settled_after_cooldown);
    RUN_TEST(test_cleared_low_battery_with_hysteresis);

    // pressure_change rate limit
    RUN_TEST(test_default_pressure_alert_delta_is_10_hpa);
    RUN_TEST(test_pressure_step_of_exactly_10_hpa_does_not_alert);
    RUN_TEST(test_por_band_identical_values_alert_once_across_three_windows);
    RUN_TEST(test_pressure_alert_cooldown_survives_millis_wrap);
    RUN_TEST(test_pressure_oscillation_is_rate_limited);
    RUN_TEST(test_genuine_pressure_step_alerts_once);
    RUN_TEST(test_second_pressure_step_waits_for_cooldown);

    // sensorsBuildAlert
    RUN_TEST(test_build_alert_temp_high);
    RUN_TEST(test_build_alert_low_battery);
    RUN_TEST(test_build_alert_unknown_flag);
    RUN_TEST(test_build_alert_returns_early_when_alert_null);

    return UNITY_END();
}
