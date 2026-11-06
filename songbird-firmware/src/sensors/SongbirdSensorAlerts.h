/**
 * @file SongbirdSensorAlerts.h
 * @brief Pure alert threshold checks (no sensor hardware)
 *
 * Split out of SongbirdSensors.cpp so host tests compile the same logic
 * the firmware runs. Humidity high keeps its latch and its clear margin,
 * and also stays quiet for SENSOR_HUMIDITY_ALERT_COOLDOWN_MS after a note
 * so a power-on sample that alternates with a real reading cannot emit
 * humidity_high on every spike.
 *
 * Pressure behavior is unchanged: a pressure_change flag still clears on
 * the next sample.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_SENSOR_ALERTS_H
#define SONGBIRD_SENSOR_ALERTS_H

#include <math.h>
#include <stdint.h>
#include "SongbirdConfig.h"

/**
 * @brief True while a humidity_high note is still inside its quiet interval
 *
 * haveNote is false until SensorTask has sent one humidity_high this boot.
 * The timestamp is task-local and is not persisted, so a reboot may emit
 * one more note. Unsigned subtraction is wrap-safe.
 */
inline bool humidityHighCoolingDown(bool haveNote,
                                    uint32_t nowMs,
                                    uint32_t lastNoteMs) {
    if (!haveNote) {
        return false;
    }
    return (uint32_t)(nowMs - lastNoteMs) < SENSOR_HUMIDITY_ALERT_COOLDOWN_MS;
}

/**
 * @brief Check sensor data against alert thresholds
 *
 * Compares current sensor readings against configured thresholds.
 * Returns bitmask of newly triggered alerts.
 *
 * Humidity high is edge-triggered while the latch is clear, and is also
 * suppressed for SENSOR_HUMIDITY_ALERT_COOLDOWN_MS after the last note.
 * A stuck over-threshold reading therefore alerts once (the latch holds).
 * A reading that drops below the clear margin and comes back alerts again
 * only after that quiet interval. Passing haveHumidityHighNote false keeps
 * the historical latch-only behavior for callers that have not recorded a
 * note yet.
 *
 * @param data Current sensor data
 * @param config Current configuration with thresholds
 * @param previousPressure Previous pressure reading (for delta check)
 * @param currentAlerts Current alert state (for deduplication)
 * @param haveHumidityHighNote True after humidity_high has been sent this boot
 * @param nowMs Monotonic millisecond clock (wrap-safe against lastNoteMs)
 * @param humidityHighNoteMs nowMs when humidity_high last fired
 * @return Bitmask of newly triggered alerts (ALERT_FLAG_*)
 */
inline uint8_t sensorsCheckAlerts(const SensorData* data,
                                  const SongbirdConfig* config,
                                  float previousPressure,
                                  uint8_t currentAlerts,
                                  bool haveHumidityHighNote = false,
                                  uint32_t nowMs = 0,
                                  uint32_t humidityHighNoteMs = 0) {
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

    // Humidity high. The latch stops a sustained over-threshold reading.
    // The quiet interval stops the songbird-14 pattern, where a constant
    // ~92% RH sample alternates with a real reading below the clear margin
    // and every spike is a new edge.
    if (!(currentAlerts & ALERT_FLAG_HUMIDITY_HIGH) &&
        data->humidity > config->humidityAlertHigh &&
        !humidityHighCoolingDown(haveHumidityHighNote, nowMs, humidityHighNoteMs)) {
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

    // Low battery. 0 V is a failed/stale sample, not a dead pack — same
    // predicate as voltageIsLowBattery().
    if (!(currentAlerts & ALERT_FLAG_LOW_BATTERY) &&
        data->voltage > 0 && data->voltage < config->voltageAlertLow) {
        newAlerts |= ALERT_FLAG_LOW_BATTERY;
    }

    return newAlerts;
}

/**
 * @brief Check which alerts have cleared
 *
 * Returns bitmask of alerts that were active but have now cleared
 * (values returned to normal range).
 *
 * Humidity high still clears only once the reading is
 * SENSOR_HUMIDITY_ALERT_CLEAR_MARGIN_PCT below the threshold. The quiet
 * interval does not hold the latch: a real drop below that margin releases
 * it, and sensorsCheckAlerts decides whether the next crossing is inside
 * the quiet interval.
 *
 * @param data Current sensor data
 * @param config Current configuration with thresholds
 * @param currentAlerts Currently active alerts
 * @return Bitmask of cleared alerts
 */
inline uint8_t sensorsCheckAlertsCleared(const SensorData* data,
                                          const SongbirdConfig* config,
                                          uint8_t currentAlerts) {
    if (data == NULL || config == NULL || !data->valid) {
        return 0;
    }

    uint8_t clearedAlerts = 0;

    // Use hysteresis to prevent alert flapping
    // Clear threshold is 10% back from trigger threshold

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
        data->humidity < (config->humidityAlertHigh - SENSOR_HUMIDITY_ALERT_CLEAR_MARGIN_PCT)) {
        clearedAlerts |= ALERT_FLAG_HUMIDITY_HIGH;
    }

    // Humidity low cleared
    if ((currentAlerts & ALERT_FLAG_HUMIDITY_LOW) &&
        data->humidity > (config->humidityAlertLow + 5.0f)) {
        clearedAlerts |= ALERT_FLAG_HUMIDITY_LOW;
    }

    // Pressure delta always clears after being reported once
    // (it's a transient event, not a sustained condition)
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

#endif // SONGBIRD_SENSOR_ALERTS_H
