/**
 * @file SongbirdSensors.h
 * @brief BME280 environmental sensor interface for Songbird
 *
 * Provides thread-safe access to temperature, humidity,
 * and pressure readings from the BME280 sensor.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_SENSORS_H
#define SONGBIRD_SENSORS_H

#include <Arduino.h>
#include "SongbirdConfig.h"

// =============================================================================
// Sensor Module Interface
// =============================================================================

/**
 * @brief Initialize the BME280 sensor
 *
 * Must be called after I2C is initialized.
 * Does NOT acquire I2C mutex - caller must handle this.
 *
 * @return true if sensor initialized successfully
 */
bool sensorsInit(void);

/**
 * @brief Check if the sensor is available
 *
 * @return true if sensor was initialized successfully
 */
bool sensorsIsAvailable(void);

/**
 * @brief Read all sensor values
 *
 * Does NOT acquire I2C mutex - caller must handle this.
 * Populates all fields of SensorData structure.
 *
 * @param data Pointer to SensorData structure to fill
 * @return true if read successful
 */
bool sensorsRead(SensorData* data);

/**
 * @brief Read temperature only
 *
 * Does NOT acquire I2C mutex - caller must handle this.
 *
 * @return Temperature in Celsius, or NAN on error
 */
float sensorsReadTemperature(void);

/**
 * @brief Read humidity only
 *
 * Does NOT acquire I2C mutex - caller must handle this.
 *
 * @return Relative humidity percentage (0-100), or NAN on error
 */
float sensorsReadHumidity(void);

/**
 * @brief Read pressure only
 *
 * Does NOT acquire I2C mutex - caller must handle this.
 *
 * @return Barometric pressure in hPa, or NAN on error
 */
float sensorsReadPressure(void);

/**
 * @brief Get the number of sensor read errors since init
 *
 * @return Error count
 */
uint32_t sensorsGetErrorCount(void);

/**
 * @brief Reset the sensor error count
 */
void sensorsResetErrorCount(void);

// =============================================================================
// Alert Checking
// =============================================================================

/**
 * @brief Check sensor data against alert thresholds
 *
 * Compares current sensor readings against configured thresholds.
 * Returns bitmask of triggered alerts.
 *
 * @param data Current sensor data
 * @param config Current configuration with thresholds
 * @param previousPressure Previous pressure reading (for delta check)
 * @param currentAlerts Current alert state (for deduplication)
 * @return Bitmask of newly triggered alerts (ALERT_FLAG_*)
 */
uint8_t sensorsCheckAlerts(const SensorData* data,
                           const SongbirdConfig* config,
                           float previousPressure,
                           uint8_t currentAlerts);

/**
 * @brief Check which alerts have cleared
 *
 * Returns bitmask of alerts that were active but have now cleared
 * (values returned to normal range).
 *
 * @param data Current sensor data
 * @param config Current configuration with thresholds
 * @param currentAlerts Currently active alerts
 * @return Bitmask of cleared alerts
 */
uint8_t sensorsCheckAlertsCleared(const SensorData* data,
                                   const SongbirdConfig* config,
                                   uint8_t currentAlerts);

/**
 * @brief Build an Alert structure for a triggered alert
 *
 * @param alertFlag Single alert flag (e.g., ALERT_FLAG_TEMP_HIGH)
 * @param data Current sensor data
 * @param config Current configuration
 * @param alert Pointer to Alert structure to fill
 */
void sensorsBuildAlert(uint8_t alertFlag,
                       const SensorData* data,
                       const SongbirdConfig* config,
                       Alert* alert);

#endif // SONGBIRD_SENSORS_H
