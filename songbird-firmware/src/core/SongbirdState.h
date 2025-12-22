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
#define STATE_VERSION 3

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
    uint8_t reserved[10];       // Reserved for future use
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
