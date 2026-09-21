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
static uint8_t s_i2cAddr = BME280_I2C_ADDRESS;
static uint32_t s_resetCount = 0;

// BME280 register map (subset needed for reset detection)
#define BME280_REG_CTRL_HUM     0xF2
#define BME280_REG_STATUS       0xF3
#define BME280_REG_CTRL_MEAS    0xF4
#define BME280_REG_PRESS_MSB    0xF7

// Value ctrl_hum holds after sensorsInit() (osrs_h = x1). A power-on reset
// clears it to 0x00, which is how we detect that the sensor lost its config.
#define BME280_EXPECTED_CTRL_HUM 0x01

// Worst-case conversion time at x1/x1/x1 oversampling is ~9.3 ms (datasheet
// 9.1). Wait this long before polling `measuring` so we never read stale data
// because the status bit had not yet asserted.
#define BME280_MEASURE_WAIT_MS   10
#define BME280_MEASURE_TIMEOUT_MS 100

// =============================================================================
// Low-level register helpers (the Adafruit driver keeps its own private)
// =============================================================================

static bool bmeReadRegs(uint8_t reg, uint8_t* buf, uint8_t len) {
    Wire.beginTransmission(s_i2cAddr);
    Wire.write(reg);
    if (Wire.endTransmission() != 0) {
        return false;
    }
    if (Wire.requestFrom(s_i2cAddr, len) != len) {
        return false;
    }
    for (uint8_t i = 0; i < len; i++) {
        buf[i] = (uint8_t)Wire.read();
    }
    return true;
}

static void applySampling(void) {
    // Configure for weather monitoring (low power, adequate accuracy)
    s_bme.setSampling(Adafruit_BME280::MODE_FORCED,     // Take reading on demand
                      Adafruit_BME280::SAMPLING_X1,     // Temperature oversampling
                      Adafruit_BME280::SAMPLING_X1,     // Pressure oversampling
                      Adafruit_BME280::SAMPLING_X1,     // Humidity oversampling
                      Adafruit_BME280::FILTER_OFF,      // No IIR filter
                      Adafruit_BME280::STANDBY_MS_1000);
}

/**
 * @brief Detect whether the BME280 has been reset since sensorsInit()
 *
 * A supply dip (USB reconnect, modem/GPS power-up in transit mode) can trip
 * the BME280's POR while the MCU rides through. The sensor comes back with
 * ctrl_hum/ctrl_meas cleared and its data registers holding the reset value
 * 0x80000, which the Adafruit driver compensates into a plausible-looking but
 * bogus reading (~23C, ~90%RH, 600-770 hPa). Check the config register and
 * re-apply sampling if it has been wiped.
 *
 * @return true if the sensor was found reset and has been reconfigured
 */
static bool bmeRecoverIfReset(void) {
    uint8_t ctrlHum = 0xFF;
    if (!bmeReadRegs(BME280_REG_CTRL_HUM, &ctrlHum, 1)) {
        return false;  // bus error; caller's read will fail on its own
    }
    if ((ctrlHum & 0x07) == BME280_EXPECTED_CTRL_HUM) {
        return false;
    }
    s_resetCount++;
    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Sensors] BME280 config lost (ctrl_hum=0x");
    DEBUG_SERIAL.print(ctrlHum, HEX);
    DEBUG_SERIAL.println(") - sensor was reset, reapplying sampling");
    #endif
    applySampling();
    return true;
}

/**
 * @brief Trigger one forced measurement and wait for it to complete
 *
 * Replaces Adafruit_BME280::takeForcedMeasurement(), which returns as soon as
 * the `measuring` status bit reads clear. Immediately after the mode write
 * that bit can still be clear, so the caller ends up reading the previous
 * (or, after a reset, the power-on) contents of the data registers.
 */
static bool bmeForcedMeasure(void) {
    if (!s_bme.takeForcedMeasurement()) {
        return false;
    }
    // Give the conversion time to run regardless of what `measuring` said.
    delay(BME280_MEASURE_WAIT_MS);
    uint32_t start = millis();
    uint8_t status = 0;
    do {
        if (!bmeReadRegs(BME280_REG_STATUS, &status, 1)) {
            return false;
        }
        if ((status & 0x08) == 0) {
            return true;
        }
        delay(1);
    } while (millis() - start < BME280_MEASURE_TIMEOUT_MS);
    return false;
}

/**
 * @brief Check the raw data registers for the BME280 reset/skipped signature
 *
 * After POR (or with a channel skipped) the sensor reports 0x80000 for
 * temperature and pressure and 0x8000 for humidity. The Adafruit driver
 * (2.3.0) does not reject these; do it here so they never become a sample.
 */
static bool bmeRawIsResetValue(void) {
    uint8_t raw[8];
    if (!bmeReadRegs(BME280_REG_PRESS_MSB, raw, sizeof(raw))) {
        return true;  // can't verify; treat as invalid
    }
    bool pressReset = (raw[0] == 0x80 && raw[1] == 0x00 && (raw[2] & 0xF0) == 0x00);
    bool tempReset  = (raw[3] == 0x80 && raw[4] == 0x00 && (raw[5] & 0xF0) == 0x00);
    bool humReset   = (raw[6] == 0x80 && raw[7] == 0x00);
    return pressReset || tempReset || humReset;
}

// =============================================================================
// Initialization
// =============================================================================

bool sensorsInit(void) {
    // Try to initialize BME280 at configured address
    s_i2cAddr = BME280_I2C_ADDRESS;
    if (!s_bme.begin(BME280_I2C_ADDRESS, &Wire)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.print("[Sensors] BME280 not found at 0x");
        DEBUG_SERIAL.println(BME280_I2C_ADDRESS, HEX);
        #endif

        // Try alternate address (0x76)
        s_i2cAddr = 0x76;
        if (!s_bme.begin(0x76, &Wire)) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.println("[Sensors] BME280 not found at 0x76 either");
            #endif
            s_initialized = false;
            return false;
        }
    }

    applySampling();

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

    // If a supply dip reset the sensor since the last read, restore its
    // sampling config before asking for a measurement. Without this the
    // forced-mode write lands on a sensor with humidity skipped and the
    // data registers still at their power-on value.
    bmeRecoverIfReset();

    // Take a forced reading and wait for the conversion to finish. Retry once:
    // a reset detected mid-cycle leaves the first attempt reading POR values.
    bool measured = false;
    for (uint8_t attempt = 0; attempt < 2 && !measured; attempt++) {
        if (!bmeForcedMeasure()) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.println("[Sensors] Failed to take forced measurement");
            #endif
            continue;
        }
        if (bmeRawIsResetValue()) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.println("[Sensors] Data registers hold POR value - discarding sample");
            #endif
            s_resetCount++;
            bmeRecoverIfReset();
            continue;
        }
        measured = true;
    }
    if (!measured) {
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

    bmeRecoverIfReset();
    if (!bmeForcedMeasure() || bmeRawIsResetValue()) {
        s_errorCount++;
        return NAN;
    }

    return s_bme.readTemperature();
}

float sensorsReadHumidity(void) {
    if (!s_initialized) {
        return NAN;
    }

    bmeRecoverIfReset();
    if (!bmeForcedMeasure() || bmeRawIsResetValue()) {
        s_errorCount++;
        return NAN;
    }

    return s_bme.readHumidity();
}

float sensorsReadPressure(void) {
    if (!s_initialized) {
        return NAN;
    }

    bmeRecoverIfReset();
    if (!bmeForcedMeasure() || bmeRawIsResetValue()) {
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

uint32_t sensorsGetResetCount(void) {
    return s_resetCount;
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
                     "Battery voltage low. Charge now.");
            break;

        default:
            alert->type = "unknown";
            snprintf(alert->message, sizeof(alert->message), "Unknown alert");
            break;
    }
}
