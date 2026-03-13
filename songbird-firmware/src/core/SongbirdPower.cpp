/**
 * @file SongbirdPower.cpp
 * @brief Power monitoring implementation for Songbird
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdPower.h"
#include "SongbirdState.h"

#include <Arduino.h>
#include <stm32l4xx_hal.h>

// =============================================================================
// Module State
// =============================================================================

static BootCause s_bootCause = BOOT_CAUSE_UNKNOWN;

// Boot-loop counter backed purely by SRAM (not Notecard payload).
//
// The STM32L433 retains SRAM across BOR resets as long as VDD stays above
// the SRAM retention floor (~1.7V). This means the counter survives the rapid
// power-cycle of a boot-loop without requiring I2C to the Notecard, which may
// be unreliable at critically low voltage.
//
// A magic-value guard distinguishes "counter was initialised this power cycle"
// from stale SRAM on the very first cold boot after a true power-off.
//
// If the device does fully discharge and lose SRAM, the counter resets to 0 —
// that's correct behaviour because a full discharge means the boot-loop
// condition has naturally cleared.
#define BOOT_LOOP_SRAM_MAGIC  0xB007U
static uint16_t s_bootLoopMagic    = 0;
static uint8_t  s_sramBrownoutCount = 0;

// =============================================================================
// PVD Shutdown Flag (set from ISR, consumed by MainTask)
// =============================================================================

// Declared extern in SongbirdSync.h — defined here as the owning translation unit.
// Must be volatile so the compiler does not optimize away reads in the task loop.
volatile bool g_pvdShutdownRequested = false;

// =============================================================================
// Initialization
// =============================================================================

void powerInit(void) {
    // -------------------------------------------------------------------------
    // 1. Read and record boot cause from RCC->CSR before clearing flags
    // -------------------------------------------------------------------------
    uint32_t csr = RCC->CSR;

    if (csr & RCC_CSR_BORRSTF) {
        s_bootCause = BOOT_CAUSE_BROWNOUT;
    } else if (csr & RCC_CSR_IWDGRSTF) {
        s_bootCause = BOOT_CAUSE_WATCHDOG;
    } else if (csr & (RCC_CSR_PINRSTF | RCC_CSR_SFTRSTF)) {
        s_bootCause = BOOT_CAUSE_NORMAL;
    } else {
        s_bootCause = BOOT_CAUSE_UNKNOWN;
    }

    // Clear all reset flags
    RCC->CSR |= RCC_CSR_RMVF;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Power] Boot cause: ");
    DEBUG_SERIAL.println(powerGetBootCauseString());
    #endif

    // -------------------------------------------------------------------------
    // 2. Configure and enable PVD (~2.9V falling-edge interrupt)
    // -------------------------------------------------------------------------
    // Enable PWR clock (required before accessing PWR registers)
    __HAL_RCC_PWR_CLK_ENABLE();

    PWR_PVDTypeDef pvdConfig;
    pvdConfig.PVDLevel = PVD_SHUTDOWN_LEVEL;            // ~2.9V
    pvdConfig.Mode    = PWR_PVD_MODE_IT_FALLING;        // Interrupt on falling edge only

    HAL_PWR_ConfigPVD(&pvdConfig);

    // Configure NVIC for PVD/PVM interrupt
    HAL_NVIC_SetPriority(PVD_PVM_IRQn, 0, 0);   // Highest priority
    HAL_NVIC_EnableIRQ(PVD_PVM_IRQn);

    HAL_PWR_EnablePVD();

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Power] PVD enabled at ~2.9V (PWR_PVDLEVEL_6)");
    #endif
}

// =============================================================================
// Boot Cause Accessors
// =============================================================================

BootCause powerGetBootCause(void) {
    return s_bootCause;
}

const char* powerGetBootCauseString(void) {
    switch (s_bootCause) {
        case BOOT_CAUSE_BROWNOUT: return "brownout";
        case BOOT_CAUSE_WATCHDOG: return "watchdog";
        case BOOT_CAUSE_NORMAL:   return "normal";
        default:                  return "unknown";
    }
}

bool powerWasBrownoutReset(void) {
    return s_bootCause == BOOT_CAUSE_BROWNOUT;
}

// =============================================================================
// Boot-Loop Detection
// =============================================================================

bool powerCheckAndHandleBootLoop(void) {
    if (!powerWasBrownoutReset()) {
        // Not a brownout boot — reset both the SRAM counter and the Notecard
        // backed counter (best-effort; Notecard may not be available yet).
        s_bootLoopMagic     = BOOT_LOOP_SRAM_MAGIC;
        s_sramBrownoutCount = 0;
        stateResetConsecutiveBrownouts();
        return false;
    }

    // Brownout boot detected.
    //
    // Primary counter: SRAM (reliable at low voltage, no I2C required).
    // Secondary counter: Notecard state (best-effort, used for cloud visibility).
    //
    // Initialise SRAM counter on first use (cold boot from power-off).
    if (s_bootLoopMagic != BOOT_LOOP_SRAM_MAGIC) {
        s_bootLoopMagic     = BOOT_LOOP_SRAM_MAGIC;
        s_sramBrownoutCount = 0;
    }

    if (s_sramBrownoutCount < 255) {
        s_sramBrownoutCount++;
    }

    // Mirror into state (best-effort — may fail if Notecard I2C unreliable).
    stateIncrementConsecutiveBrownouts();

    uint8_t count = s_sramBrownoutCount;  // Use SRAM as authoritative count

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Power] Consecutive brownout boots (SRAM): ");
    DEBUG_SERIAL.println(count);
    #endif

    if (count < BOOT_LOOP_MAX_COUNT) {
        // Not yet at threshold — allow normal boot
        return false;
    }

    // Boot-loop threshold reached — enter low-power hold.
    DEBUG_SERIAL.print("[Power] Boot-loop detected (");
    DEBUG_SERIAL.print(count);
    DEBUG_SERIAL.print(" consecutive brownouts). Holding ");
    DEBUG_SERIAL.print(BOOT_LOOP_HOLD_SEC);
    DEBUG_SERIAL.println("s to allow battery recovery...");

    // Reset both counters so the next boot after the hold starts fresh.
    s_sramBrownoutCount = 0;
    stateResetConsecutiveBrownouts();

    // Hold in a simple delay loop. The STM32 HAL delay is sufficient here
    // because FreeRTOS hasn't started yet. LED blinks to indicate hold state.
    uint32_t holdMs = (uint32_t)BOOT_LOOP_HOLD_SEC * 1000UL;
    uint32_t start  = millis();
    bool ledState   = false;

    while (millis() - start < holdMs) {
        // Blink built-in LED slowly to indicate hold
        ledState = !ledState;
        digitalWrite(LED_PIN, ledState ? HIGH : LOW);
        delay(500);
    }

    digitalWrite(LED_PIN, LOW);

    DEBUG_SERIAL.println("[Power] Boot-loop hold complete. Resuming boot.");
    return true;
}

// =============================================================================
// PVD Interrupt Handler
// =============================================================================

/**
 * @brief PVD/PVM interrupt handler
 *
 * Called by the NVIC when VDD crosses the PVD threshold (falling edge = low).
 * MUST NOT perform any blocking operations — only set a flag for task context.
 */
extern "C" void PVD_PVM_IRQHandler(void) {
    HAL_PWR_PVD_PVM_IRQHandler();
}

/**
 * @brief PVD callback — called from HAL_PWR_PVD_IRQHandler()
 *
 * Override the weak HAL default. Sets the global shutdown flag.
 */
extern "C" void HAL_PWR_PVDCallback(void) {
    g_pvdShutdownRequested = true;
}
