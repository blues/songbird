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
#include "SongbirdSensorAlerts.h"

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

/**
 * @brief Number of times the BME280 was found reset (config wiped or data
 *        registers at their power-on value) since boot
 *
 * A non-zero count indicates supply dips reaching the sensor; useful for
 * health reporting and for tracking down flaky USB or rail sag in transit.
 */
uint32_t sensorsGetResetCount(void);

// =============================================================================
// Alert Checking
// =============================================================================
// sensorsCheckAlerts() and sensorsCheckAlertsCleared() live in
// SongbirdSensorAlerts.h so the native tests compile the firmware logic.

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
