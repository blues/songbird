/**
 * @file SongbirdSensorAlerts.h
 * @brief Pure alert threshold checks (no sensor hardware)
 *
 * Split out of SongbirdSensors.cpp so host tests compile the same logic
 * the firmware runs. Pressure uses an anchor plus a cooldown: the flag used
 * to clear on the next sample, and the edge detector then compared against
 * whatever the previous accepted reading happened to be.
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
 * @brief Usable barometric sample for a delta comparison
 *
 * Non-positive and NaN readings are "no baseline", matching the historical
 * previousPressure > 0 guard.
 */
inline bool pressureSampleUsable(float pressure) {
    return !isnan(pressure) && pressure > 0.0f;
}

/**
 * @brief True while a pressure_change note is still inside its quiet interval
 */
inline bool pressureAlertCoolingDown(float lastAlertedPressure,
                                            uint32_t nowMs,
                                            uint32_t lastAlertMs) {
    if (!pressureSampleUsable(lastAlertedPressure)) {
        return false;
    }
    return (uint32_t)(nowMs - lastAlertMs) < SENSOR_PRESSURE_ALERT_COOLDOWN_MS;
}

/**
 * @brief Check sensor data against alert thresholds
 *
 * Compares current sensor readings against configured thresholds.
 * Returns bitmask of newly triggered alerts.
 *
 * Pressure is not purely edge-triggered off the previous sample. After a
 * pressure_change note, further notes are suppressed until
 * SENSOR_PRESSURE_ALERT_COOLDOWN_MS has elapsed, and the comparison is
 * against the sample that raised the last note (lastAlertedPressure) rather
 * than the latest accepted reading. A stuck POR-band value therefore alerts
 * once. A later reading more than pressureAlertDelta from that anchor can
 * alert again, but not inside the quiet interval — so one oscillating
 * baseline cannot emit a row every sensor period.
 *
 * Passing a non-usable lastAlertedPressure (NaN) keeps the historical
 * single-sample behavior so callers that have not yet recorded an anchor
 * still report the first trip. The flag suppresses that path; once an
 * anchor exists the cooldown is the latch, and a post-interval trip is a
 * new event even if the flag is still held.
 *
 * @param data Current sensor data
 * @param config Current configuration with thresholds
 * @param previousPressure Previous pressure reading (for the first delta)
 * @param currentAlerts Current alert state (for deduplication)
 * @param lastAlertedPressure Pressure that last raised pressure_change, or NaN
 * @param nowMs Monotonic millisecond clock (wrap-safe against lastAlertMs)
 * @param lastAlertMs nowMs when pressure_change last fired; ignored without an anchor
 * @return Bitmask of newly triggered alerts (ALERT_FLAG_*)
 */
inline uint8_t sensorsCheckAlerts(const SensorData* data,
                                         const SongbirdConfig* config,
                                         float previousPressure,
                                         uint8_t currentAlerts,
                                         float lastAlertedPressure = NAN,
                                         uint32_t nowMs = 0,
                                         uint32_t lastAlertMs = 0) {
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

    // Pressure delta. See the comment above for why this is not the
    // previous-sample edge the other thresholds use.
    {
        bool haveAnchor = pressureSampleUsable(lastAlertedPressure);
        bool coolingDown = pressureAlertCoolingDown(lastAlertedPressure, nowMs, lastAlertMs);
        float reference = haveAnchor ? lastAlertedPressure : previousPressure;
        bool tripped = pressureSampleUsable(reference) &&
            fabs(data->pressure - reference) > config->pressureAlertDelta;
        bool heldWithoutAnchor = !haveAnchor &&
            (currentAlerts & ALERT_FLAG_PRESSURE_DELTA);
        if (tripped && !coolingDown && !heldWithoutAnchor) {
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
 * Pressure does not clear on sight. The latch stays set until the cooldown
 * has elapsed AND the reading is within SENSOR_PRESSURE_ALERT_HYSTERESIS_HPA
 * of the sample that raised it. A missing anchor is released immediately so
 * a restored flag cannot stick with no sample to settle against. A reading
 * that is still far from the anchor keeps the latch; sensorsCheckAlerts
 * reports a new event from that excursion only after the cooldown, and
 * SensorTask then moves the anchor.
 *
 * @param data Current sensor data
 * @param config Current configuration with thresholds
 * @param currentAlerts Currently active alerts
 * @param lastAlertedPressure Pressure that last raised pressure_change, or NaN
 * @param nowMs Monotonic millisecond clock
 * @param lastAlertMs nowMs when pressure_change last fired
 * @return Bitmask of cleared alerts
 */
inline uint8_t sensorsCheckAlertsCleared(const SensorData* data,
                                                const SongbirdConfig* config,
                                                uint8_t currentAlerts,
                                                float lastAlertedPressure = NAN,
                                                uint32_t nowMs = 0,
                                                uint32_t lastAlertMs = 0) {
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
        data->humidity < (config->humidityAlertHigh - 5.0f)) {
        clearedAlerts |= ALERT_FLAG_HUMIDITY_HIGH;
    }

    // Humidity low cleared
    if ((currentAlerts & ALERT_FLAG_HUMIDITY_LOW) &&
        data->humidity > (config->humidityAlertLow + 5.0f)) {
        clearedAlerts |= ALERT_FLAG_HUMIDITY_LOW;
    }

    // Pressure latch: hold through the quiet interval, then release once
    // the reading has settled on the sample we alerted on. Clearing on the
    // next sample (the old "transient event" path) re-armed the detector.
    if (currentAlerts & ALERT_FLAG_PRESSURE_DELTA) {
        if (!pressureSampleUsable(lastAlertedPressure)) {
            clearedAlerts |= ALERT_FLAG_PRESSURE_DELTA;
        } else if (!pressureAlertCoolingDown(lastAlertedPressure, nowMs, lastAlertMs) &&
                   fabs(data->pressure - lastAlertedPressure) <=
                       SENSOR_PRESSURE_ALERT_HYSTERESIS_HPA) {
            clearedAlerts |= ALERT_FLAG_PRESSURE_DELTA;
        }
    }

    // Low battery cleared (with hysteresis)
    if ((currentAlerts & ALERT_FLAG_LOW_BATTERY) &&
        data->voltage > (config->voltageAlertLow + 0.1f)) {
        clearedAlerts |= ALERT_FLAG_LOW_BATTERY;
    }

    return clearedAlerts;
}

#endif // SONGBIRD_SENSOR_ALERTS_H
