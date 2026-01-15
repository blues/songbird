/**
 * @file SongbirdState.h
 * @brief State persistence interface for Songbird
 *
 * Manages device state that persists across sleep cycles
 * using Notecard payload feature.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_STATE_H
#define SONGBIRD_STATE_H

#include <Arduino.h>
#include "SongbirdConfig.h"

// =============================================================================
// State Structure
// =============================================================================

// Magic number to validate state data
#define STATE_MAGIC 0x534F4E47  // "SONG"
#define STATE_VERSION 4

/**
 * @brief Persistent state structure
 *
 * This structure is saved to Notecard payload before sleep
 * and restored after wake to maintain continuity.
 */
typedef struct {
    uint32_t magic;             // Magic number for validation
    uint8_t version;            // Structure version
    uint32_t bootCount;         // Number of boot cycles
    uint32_t lastSyncTime;      // Last successful sync (uptime ms)
    uint32_t lastGpsFixTime;    // Last GPS fix (uptime ms)
    float lastPressure;         // Previous pressure reading (for delta alerts)
    OperatingMode currentMode;  // Current operating mode
    uint8_t alertsSent;         // Bitmask of active alerts
    bool motionSinceLastReport; // Motion detected since last track note
    uint32_t uptimeAtSleep;     // Uptime when entering sleep
    uint32_t totalUptimeSec;    // Cumulative uptime across sleeps
    bool transitLocked;         // Transit lock is active (double-click engaged)
    OperatingMode preTransitMode; // Mode before transit lock was engaged
    bool demoLocked;            // Demo lock is active (triple-click engaged)
    OperatingMode preDemoMode;  // Mode before demo lock was engaged

    // GPS Power Management (Transit Mode)
    bool gpsPowerSaving;        // GPS is currently disabled for power saving
    bool gpsWasActive;          // GPS was active in last status check (for transition detection)
    uint32_t gpsActiveStartTime; // millis() when GPS became active without signal
    uint32_t lastGpsRetryTime;  // millis() when GPS was last re-enabled for retry

    uint8_t reserved[1];        // Reserved for future use
    uint32_t checksum;          // CRC32 checksum
} SongbirdState;

// =============================================================================
// State Module Interface
// =============================================================================

/**
 * @brief Initialize state module
 *
 * Sets up default state values.
 */
void stateInit(void);

/**
 * @brief Get pointer to current state
 *
 * @return Pointer to state structure
 */
SongbirdState* stateGet(void);

/**
 * @brief Try to restore state from Notecard payload
 *
 * Caller must hold I2C mutex.
 *
 * @return true if state restored successfully (warm boot)
 */
bool stateRestore(void);

/**
 * @brief Save state to Notecard payload for sleep
 *
 * Caller must hold I2C mutex.
 *
 * @return true if state saved successfully
 */
bool stateSave(void);

/**
 * @brief Check if this is a warm boot (state was restored)
 *
 * @return true if warm boot
 */
bool stateIsWarmBoot(void);

/**
 * @brief Increment boot count
 */
void stateIncrementBootCount(void);

/**
 * @brief Update last sync time
 */
void stateUpdateSyncTime(void);

/**
 * @brief Update last GPS fix time
 */
void stateUpdateGpsFixTime(void);

/**
 * @brief Update last pressure reading
 *
 * @param pressure Pressure in hPa
 */
void stateUpdateLastPressure(float pressure);

/**
 * @brief Set current operating mode
 *
 * @param mode New operating mode
 */
void stateSetMode(OperatingMode mode);

/**
 * @brief Set an alert as active
 *
 * @param alertFlag Alert flag to set (ALERT_FLAG_*)
 */
void stateSetAlert(uint8_t alertFlag);

/**
 * @brief Clear an alert
 *
 * @param alertFlag Alert flag to clear (ALERT_FLAG_*)
 */
void stateClearAlert(uint8_t alertFlag);

/**
 * @brief Get active alerts bitmask
 *
 * @return Alert flags bitmask
 */
uint8_t stateGetAlerts(void);

/**
 * @brief Set motion detected flag
 *
 * @param motion Motion detected
 */
void stateSetMotion(bool motion);

/**
 * @brief Get and clear motion flag
 *
 * @return true if motion was detected
 */
bool stateGetAndClearMotion(void);

/**
 * @brief Prepare state for sleep
 *
 * Updates uptime counters before sleep.
 */
void statePrepareForSleep(void);

/**
 * @brief Get total uptime in seconds
 *
 * Includes time from previous wake cycles.
 *
 * @return Total uptime in seconds
 */
uint32_t stateGetTotalUptimeSec(void);

/**
 * @brief Get boot count
 *
 * @return Number of boot cycles
 */
uint32_t stateGetBootCount(void);

/**
 * @brief Get last pressure reading
 *
 * @return Pressure in hPa, or NAN if none
 */
float stateGetLastPressure(void);

/**
 * @brief Set transit lock state
 *
 * When locking, saves the previous mode so it can be restored.
 *
 * @param locked Whether transit lock is active
 * @param previousMode Mode to save (only used when locking)
 */
void stateSetTransitLock(bool locked, OperatingMode previousMode);

/**
 * @brief Check if transit lock is active
 *
 * @return true if transit lock is engaged
 */
bool stateIsTransitLocked(void);

/**
 * @brief Get the mode saved before transit lock was engaged
 *
 * @return The previous operating mode
 */
OperatingMode stateGetPreTransitMode(void);

/**
 * @brief Set demo lock state
 *
 * When locking, saves the previous mode so it can be restored.
 *
 * @param locked Whether demo lock is active
 * @param previousMode Mode to save (only used when locking)
 */
void stateSetDemoLock(bool locked, OperatingMode previousMode);

/**
 * @brief Check if demo lock is active
 *
 * @return true if demo lock is engaged
 */
bool stateIsDemoLocked(void);

/**
 * @brief Get the mode saved before demo lock was engaged
 *
 * @return The previous operating mode
 */
OperatingMode stateGetPreDemoMode(void);

// =============================================================================
// GPS Power Management
// =============================================================================

/**
 * @brief Set GPS power saving state
 *
 * @param enabled true if GPS is in power-saving mode (disabled)
 */
void stateSetGpsPowerSaving(bool enabled);

/**
 * @brief Check if GPS is in power saving mode
 *
 * @return true if GPS is disabled for power saving
 */
bool stateIsGpsPowerSaving(void);

/**
 * @brief Set last GPS retry time
 *
 * @param time millis() timestamp when GPS was re-enabled
 */
void stateSetLastGpsRetryTime(uint32_t time);

/**
 * @brief Get last GPS retry time
 *
 * @return millis() timestamp when GPS was last re-enabled, or 0 if never
 */
uint32_t stateGetLastGpsRetryTime(void);

/**
 * @brief Set GPS active state for transition detection
 *
 * @param active true if GPS is currently active
 */
void stateSetGpsWasActive(bool active);

/**
 * @brief Get previous GPS active state
 *
 * @return true if GPS was active in previous check
 */
bool stateGetGpsWasActive(void);

/**
 * @brief Set GPS active start time
 *
 * @param time millis() timestamp when GPS became active
 */
void stateSetGpsActiveStartTime(uint32_t time);

/**
 * @brief Get GPS active start time
 *
 * @return millis() timestamp when GPS became active, or 0 if not tracking
 */
uint32_t stateGetGpsActiveStartTime(void);

// =============================================================================
// Checksum
// =============================================================================

/**
 * @brief Calculate CRC32 checksum of state
 *
 * @param state State structure
 * @return CRC32 checksum
 */
uint32_t stateCalculateChecksum(const SongbirdState* state);

/**
 * @brief Validate state checksum
 *
 * @param state State structure
 * @return true if checksum valid
 */
bool stateValidateChecksum(const SongbirdState* state);

#endif // SONGBIRD_STATE_H
