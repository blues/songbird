/**
 * @file SongbirdSensors.cpp
 * @brief BME280 environmental sensor implementation
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdSensors.h"
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

// =============================================================================
// Module State
// =============================================================================

static Adafruit_BME280 s_bme;
static bool s_initialized = false;
static uint32_t s_errorCount = 0;

// =============================================================================
// Initialization
// =============================================================================

bool sensorsInit(void) {
    // Try to initialize BME280 at configured address
    if (!s_bme.begin(BME280_I2C_ADDRESS, &Wire)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.print("[Sensors] BME280 not found at 0x");
        DEBUG_SERIAL.println(BME280_I2C_ADDRESS, HEX);
        #endif

        // Try alternate address (0x76)
        if (!s_bme.begin(0x76, &Wire)) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.println("[Sensors] BME280 not found at 0x76 either");
            #endif
            s_initialized = false;
            return false;
        }
    }

    // Configure for weather monitoring (low power, adequate accuracy)
    s_bme.setSampling(Adafruit_BME280::MODE_FORCED,     // Take reading on demand
                      Adafruit_BME280::SAMPLING_X1,     // Temperature oversampling
                      Adafruit_BME280::SAMPLING_X1,     // Pressure oversampling
                      Adafruit_BME280::SAMPLING_X1,     // Humidity oversampling
                      Adafruit_BME280::FILTER_OFF,      // No IIR filter
                      Adafruit_BME280::STANDBY_MS_1000);

    s_initialized = true;
    s_errorCount = 0;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Sensors] BME280 initialized");
    #endif

    return true;
}

bool sensorsIsAvailable(void) {
    return s_initialized;
}

// =============================================================================
// Sensor Reading
// =============================================================================

bool sensorsRead(SensorData* data) {
    if (data == NULL) {
        return false;
    }

    // Initialize with invalid data
    data->valid = false;
    data->temperature = NAN;
    data->humidity = NAN;
    data->pressure = NAN;
    data->voltage = 0.0f;
    data->motion = false;
    data->timestamp = 0;

    if (!s_initialized) {
        s_errorCount++;
        return false;
    }

    // Take a forced reading (wakes sensor, takes measurement, returns to sleep)
    if (!s_bme.takeForcedMeasurement()) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Sensors] Failed to take forced measurement");
        #endif
        s_errorCount++;
        return false;
    }

    // Read values
    data->temperature = s_bme.readTemperature();
    data->humidity = s_bme.readHumidity();
    data->pressure = s_bme.readPressure() / 100.0f;  // Convert Pa to hPa

    // Validate readings
    if (isnan(data->temperature) || isnan(data->humidity) || isnan(data->pressure)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Sensors] Invalid readings (NaN)");
        #endif
        s_errorCount++;
        return false;
    }

    // Sanity check ranges
    if (data->temperature < -40.0f || data->temperature > 85.0f ||
        data->humidity < 0.0f || data->humidity > 100.0f ||
        data->pressure < 300.0f || data->pressure > 1100.0f) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Sensors] Readings out of valid range");
        #endif
        s_errorCount++;
        return false;
    }

    data->valid = true;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Sensors] T=");
    DEBUG_SERIAL.print(data->temperature, 1);
    DEBUG_SERIAL.print("C H=");
    DEBUG_SERIAL.print(data->humidity, 1);
    DEBUG_SERIAL.print("% P=");
    DEBUG_SERIAL.print(data->pressure, 1);
    DEBUG_SERIAL.println("hPa");
    #endif

    return true;
}

float sensorsReadTemperature(void) {
    if (!s_initialized) {
        return NAN;
    }

    if (!s_bme.takeForcedMeasurement()) {
        s_errorCount++;
        return NAN;
    }

    return s_bme.readTemperature();
}

float sensorsReadHumidity(void) {
    if (!s_initialized) {
        return NAN;
    }

    if (!s_bme.takeForcedMeasurement()) {
        s_errorCount++;
        return NAN;
    }

    return s_bme.readHumidity();
}

float sensorsReadPressure(void) {
    if (!s_initialized) {
        return NAN;
    }

    if (!s_bme.takeForcedMeasurement()) {
        s_errorCount++;
        return NAN;
    }

    return s_bme.readPressure() / 100.0f;  // Convert Pa to hPa
}

uint32_t sensorsGetErrorCount(void) {
    return s_errorCount;
}

void sensorsResetErrorCount(void) {
    s_errorCount = 0;
}

// =============================================================================
// Alert Checking
// =============================================================================

uint8_t sensorsCheckAlerts(const SensorData* data,
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

uint8_t sensorsCheckAlertsCleared(const SensorData* data,
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
        data->humidity < (config->humidityAlertHigh - 5.0f)) {
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

void sensorsBuildAlert(uint8_t alertFlag,
                       const SensorData* data,
                       const SongbirdConfig* config,
                       Alert* alert) {
    if (alert == NULL || data == NULL || config == NULL) {
        return;
    }

    // Clear the alert structure
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
                     "Battery %.2fV below %.2fV threshold",
                     data->voltage, config->voltageAlertLow);
            break;

        default:
            alert->type = "unknown";
            snprintf(alert->message, sizeof(alert->message), "Unknown alert");
            break;
    }
}
