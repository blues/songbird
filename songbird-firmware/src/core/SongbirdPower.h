/**
 * @file SongbirdPower.h
 * @brief Power monitoring interface for Songbird
 *
 * Provides:
 *   - PVD (Programmable Voltage Detector) initialization and ISR
 *     for early-warning brownout detection (~2.9V threshold)
 *   - Boot cause detection via RCC->CSR reset flags
 *   - Boot-loop detection and prevention logic
 *
 * Design:
 *   - PVD ISR sets a volatile flag (g_pvdShutdownRequested) only —
 *     no blocking operations in interrupt context.
 *   - MainTask polls the flag and executes the safe shutdown sequence.
 *   - Boot cause is determined before FreeRTOS starts, stored in state,
 *     and optionally reported to Notehub after connection.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_POWER_H
#define SONGBIRD_POWER_H

#include <Arduino.h>
#include "SongbirdConfig.h"

// =============================================================================
// Boot Cause
// =============================================================================

typedef enum {
    BOOT_CAUSE_NORMAL = 0,  // Pin reset, power-on, or software reset
    BOOT_CAUSE_BROWNOUT,    // BOR (Brown-Out Reset) detected
    BOOT_CAUSE_WATCHDOG,    // Independent watchdog reset
    BOOT_CAUSE_UNKNOWN      // Could not determine
} BootCause;

// =============================================================================
// Power Module Interface
// =============================================================================

/**
 * @brief Initialize the power monitoring subsystem
 *
 * - Reads and clears RCC->CSR reset flags (call before clearing elsewhere)
 * - Configures and enables PVD at PVD_SHUTDOWN_LEVEL (~2.9V)
 * - Enables NVIC for PVD_PVM_IRQn
 *
 * Must be called early in setup(), before FreeRTOS scheduler starts.
 * Does NOT require I2C mutex (no Notecard access).
 */
void powerInit(void);

/**
 * @brief Get the boot cause determined at startup
 *
 * Valid after powerInit() has been called.
 *
 * @return Boot cause enum value
 */
BootCause powerGetBootCause(void);

/**
 * @brief Get the boot cause as a short string for logging
 *
 * @return "brownout", "watchdog", "normal", or "unknown"
 */
const char* powerGetBootCauseString(void);

/**
 * @brief Check if this boot was caused by a brownout reset
 *
 * @return true if RCC_CSR_BORRSTF was set at startup
 */
bool powerWasBrownoutReset(void);

/**
 * @brief Check whether boot-loop condition is detected and handle it
 *
 * Should be called from setup() after state is loaded but before
 * FreeRTOS tasks are created. If a boot-loop is detected, this function
 * enters a low-power hold for BOOT_LOOP_HOLD_SEC seconds.
 *
 * A boot-loop is defined as BOOT_LOOP_MAX_COUNT consecutive brownout
 * resets within BOOT_LOOP_WINDOW_SEC seconds.
 *
 * @return true if a boot-loop was detected (hold was entered)
 */
bool powerCheckAndHandleBootLoop(void);

#endif // SONGBIRD_POWER_H
