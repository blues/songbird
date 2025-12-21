/**
 * @file SongbirdNotecard.h
 * @brief Notecard communication interface for Songbird
 *
 * Provides thread-safe access to Notecard functionality including
 * hub configuration, note sending, GPS, and environment variables.
 *
 * Note: Functions do NOT acquire I2C mutex - caller must handle this.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_NOTECARD_H
#define SONGBIRD_NOTECARD_H

#include <Arduino.h>
#include <Notecard.h>
#include "SongbirdConfig.h"

// Note: Template type macros (TFLOAT32, TUINT32, etc.) are defined in note.h
// which is included via Notecard.h

// =============================================================================
// Notecard Module Interface
// =============================================================================

/**
 * @brief Initialize the Notecard
 *
 * Must be called after I2C is initialized.
 * Caller must hold I2C mutex.
 *
 * @return true if Notecard initialized successfully
 */
bool notecardInit(void);

/**
 * @brief Check if Notecard is available
 *
 * @return true if Notecard was initialized successfully
 */
bool notecardIsAvailable(void);

/**
 * @brief Configure the Notecard for Songbird operation
 *
 * Sets up hub.set with product UID, sync mode, and other settings.
 * Caller must hold I2C mutex.
 *
 * @param mode Operating mode (affects sync settings)
 * @return true if configuration successful
 */
bool notecardConfigure(OperatingMode mode);

/**
 * @brief Set up Note templates for bandwidth optimization
 *
 * Defines templates for track.qo, alert.qo, etc.
 * Should only be called once on cold boot.
 * Caller must hold I2C mutex.
 *
 * @return true if templates set successfully
 */
bool notecardSetupTemplates(void);

// =============================================================================
// Connection Status
// =============================================================================

/**
 * @brief Check if connected to Notehub
 *
 * Caller must hold I2C mutex.
 *
 * @return true if currently connected
 */
bool notecardIsConnected(void);

/**
 * @brief Wait for Notehub connection
 *
 * Blocks until connected or timeout.
 * Caller must hold I2C mutex.
 *
 * @param timeoutMs Maximum time to wait
 * @return true if connected, false on timeout
 */
bool notecardWaitConnection(uint32_t timeoutMs);

/**
 * @brief Force an immediate sync with Notehub
 *
 * Caller must hold I2C mutex.
 *
 * @return true if sync initiated
 */
bool notecardSync(void);

/**
 * @brief Check if a sync is currently in progress
 *
 * Caller must hold I2C mutex.
 *
 * @return true if sync in progress
 */
bool notecardIsSyncing(void);

// =============================================================================
// Note Operations
// =============================================================================

/**
 * @brief Send a tracking note to track.qo
 *
 * Caller must hold I2C mutex.
 *
 * @param data Sensor data to include in note
 * @param mode Current operating mode
 * @return true if note queued successfully
 */
bool notecardSendTrackNote(const SensorData* data, OperatingMode mode);

/**
 * @brief Send an alert note to alert.qo
 *
 * Caller must hold I2C mutex.
 *
 * @param alert Alert data
 * @return true if note queued successfully
 */
bool notecardSendAlertNote(const Alert* alert);

/**
 * @brief Send a command acknowledgment to command_ack.qo
 *
 * Caller must hold I2C mutex.
 *
 * @param ack Command acknowledgment data
 * @return true if note queued successfully
 */
bool notecardSendCommandAck(const CommandAck* ack);

/**
 * @brief Send a health note to health.qo
 *
 * Caller must hold I2C mutex.
 *
 * @param health Health data
 * @return true if note queued successfully
 */
bool notecardSendHealthNote(const HealthData* health);

// =============================================================================
// Command Reception
// =============================================================================

/**
 * @brief Check for and retrieve a pending command
 *
 * Checks command.qi for inbound commands.
 * Caller must hold I2C mutex.
 *
 * @param cmd Pointer to Command structure to fill
 * @return true if command retrieved, false if no commands pending
 */
bool notecardGetCommand(Command* cmd);

// =============================================================================
// Device Information
// =============================================================================

/**
 * @brief Get battery voltage
 *
 * Caller must hold I2C mutex.
 *
 * @return Battery voltage in volts, or 0 on error
 */
float notecardGetVoltage(void);

/**
 * @brief Check for motion since last check
 *
 * Caller must hold I2C mutex.
 *
 * @return true if motion detected
 */
bool notecardGetMotion(void);

/**
 * @brief Configure motion sensitivity
 *
 * Caller must hold I2C mutex.
 *
 * @param sensitivity Motion sensitivity level
 * @return true if configured successfully
 */
bool notecardSetMotionSensitivity(MotionSensitivity sensitivity);

/**
 * @brief Get device serial number (from Notecard)
 *
 * Caller must hold I2C mutex.
 *
 * @param buffer Buffer to store serial number
 * @param bufferSize Size of buffer
 * @return true if retrieved successfully
 */
bool notecardGetSerial(char* buffer, size_t bufferSize);

// =============================================================================
// GPS/Location
// =============================================================================

/**
 * @brief Configure GPS mode
 *
 * Caller must hold I2C mutex.
 *
 * @param mode Operating mode (affects GPS settings)
 * @return true if configured successfully
 */
bool notecardConfigureGPS(OperatingMode mode);

/**
 * @brief Configure location tracking
 *
 * Enables card.location.track for autonomous GPS tracking in transit mode.
 * In transit mode, the Notecard will automatically record location to _track.qo
 * when motion is detected, with periodic heartbeat updates.
 *
 * For all other modes, tracking is disabled to conserve power.
 *
 * Caller must hold I2C mutex.
 *
 * @param mode Operating mode (tracking only enabled in transit)
 * @return true if configured successfully
 */
bool notecardConfigureTracking(OperatingMode mode);

/**
 * @brief Configure cell tower and Wi-Fi triangulation
 *
 * Enables location triangulation using cell towers and Wi-Fi access points.
 * This provides location data when GPS is disabled or unavailable,
 * with lower power consumption and faster time-to-fix than GPS.
 *
 * On Cell+WiFi Notecards, both wifi and cell triangulation are enabled.
 * Triangulation data is processed by Notehub and included in event metadata.
 *
 * Caller must hold I2C mutex.
 *
 * @return true if configured successfully
 */
bool notecardConfigureTriangulation(void);

/**
 * @brief Get current GPS status
 *
 * Caller must hold I2C mutex.
 *
 * @param hasLock Output: true if GPS has fix
 * @param lat Output: latitude (if hasLock)
 * @param lon Output: longitude (if hasLock)
 * @param timeSeconds Output: seconds since location acquired
 * @return true if status retrieved
 */
bool notecardGetGPSStatus(bool* hasLock, double* lat, double* lon, uint32_t* timeSeconds);

// =============================================================================
// Environment Variables
// =============================================================================

/**
 * @brief Get an environment variable string
 *
 * Caller must hold I2C mutex.
 *
 * @param name Variable name
 * @param buffer Buffer to store value
 * @param bufferSize Size of buffer
 * @return true if variable found
 */
bool notecardEnvGet(const char* name, char* buffer, size_t bufferSize);

/**
 * @brief Get an environment variable as integer
 *
 * @param name Variable name
 * @param defaultValue Value to return if not found
 * @return Variable value or default
 */
int32_t notecardEnvGetInt(const char* name, int32_t defaultValue);

/**
 * @brief Get an environment variable as float
 *
 * @param name Variable name
 * @param defaultValue Value to return if not found
 * @return Variable value or default
 */
float notecardEnvGetFloat(const char* name, float defaultValue);

/**
 * @brief Get an environment variable as boolean
 *
 * @param name Variable name
 * @param defaultValue Value to return if not found
 * @return Variable value or default
 */
bool notecardEnvGetBool(const char* name, bool defaultValue);

/**
 * @brief Check if environment variables have been modified
 *
 * Compares against last known modification counter.
 * Caller must hold I2C mutex.
 *
 * @return true if variables have changed since last check
 */
bool notecardEnvModified(void);

// =============================================================================
// Sleep/Wake
// =============================================================================

/**
 * @brief Configure ATTN-based sleep
 *
 * Sets up card.attn for sleep with wake on timer, motion, or inbound commands.
 * Caller must hold I2C mutex.
 *
 * @param sleepSeconds Seconds to sleep (0 for no timer wake)
 * @param wakeOnMotion Enable motion wake
 * @param wakeOnCommand Enable wake on command.qi note
 * @param payload Optional payload to preserve (base64 encoded)
 * @param payloadSize Size of payload
 * @return true if configured successfully
 */
bool notecardConfigureSleep(uint32_t sleepSeconds,
                            bool wakeOnMotion,
                            bool wakeOnCommand,
                            const uint8_t* payload,
                            size_t payloadSize);

/**
 * @brief Enter sleep mode
 *
 * Device will lose power after this call.
 * Caller must hold I2C mutex.
 */
void notecardEnterSleep(void);

/**
 * @brief Get wake reason
 *
 * Call after wake to determine why device woke.
 * Caller must hold I2C mutex.
 *
 * @param timer Output: true if woke from timer
 * @param motion Output: true if woke from motion
 * @param command Output: true if woke from inbound command
 */
void notecardGetWakeReason(bool* timer, bool* motion, bool* command);

/**
 * @brief Retrieve payload saved before sleep
 *
 * Caller must hold I2C mutex.
 *
 * @param buffer Buffer to store payload
 * @param bufferSize Size of buffer
 * @return Actual size of payload, or 0 if none
 */
size_t notecardGetSleepPayload(uint8_t* buffer, size_t bufferSize);

// =============================================================================
// Error Handling
// =============================================================================

/**
 * @brief Get the number of Notecard errors since init
 *
 * @return Error count
 */
uint32_t notecardGetErrorCount(void);

/**
 * @brief Reset the error count
 */
void notecardResetErrorCount(void);

/**
 * @brief Get the Notecard instance (for advanced use)
 *
 * @return Pointer to Notecard instance
 */
Notecard* notecardGetInstance(void);

// =============================================================================
// Outboard DFU (ODFU) Support
// =============================================================================

/**
 * @brief Enable Outboard Device Firmware Update (ODFU)
 *
 * Configures the Notecard to receive firmware updates from Notehub and
 * flash them to the host MCU using the STM32 ROM bootloader.
 *
 * This enables over-the-air firmware updates without any host participation.
 * The Notecard handles downloading, verifying, and flashing the firmware.
 *
 * Caller must hold I2C mutex.
 *
 * @return true if ODFU enabled successfully
 */
bool notecardEnableODFU(void);

/**
 * @brief Report firmware version to Notehub
 *
 * Sends the current firmware version metadata to Notehub via dfu.status.
 * This allows Notehub to track which firmware version is running on the device.
 *
 * Caller must hold I2C mutex.
 *
 * @return true if version reported successfully
 */
bool notecardReportFirmwareVersion(void);

/**
 * @brief Build firmware version JSON string for dfu.status
 *
 * Creates a JSON string containing firmware metadata:
 * - org: Organization name
 * - product: Product name
 * - version: Semantic version
 * - ver_major, ver_minor, ver_patch: Version components
 * - description: Firmware description
 * - built: Build timestamp
 *
 * @param buffer Buffer to store JSON string
 * @param bufferSize Size of buffer
 * @return Length of JSON string, or 0 on error
 */
size_t notecardBuildVersionString(char* buffer, size_t bufferSize);

#endif // SONGBIRD_NOTECARD_H
