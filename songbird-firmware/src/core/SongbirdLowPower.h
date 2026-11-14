/**
 * @file SongbirdLowPower.h
 * @brief Stop 2 in the FreeRTOS idle path (Songbird Rev A)
 *
 * On the Cygnet build the host is expected to be power-gated by the Notecard
 * between cycles. Rev A keeps the host powered, so the host has to reach a
 * low-power state on its own. This module does it without changing how any
 * task is written: whenever every task is blocked for more than a few
 * milliseconds, the idle task stops the tick, puts the STM32U575 in Stop 2
 * with RAM retained, and on wake restores the clocks and credits the elapsed
 * time to the RTOS tick and to millis().
 *
 * Wake sources: LPTIM1 (running from the 32 kHz LSI, programmed for the next
 * task deadline), the button (PC13 EXTI), ATTN from the Notecard (PB7 EXTI)
 * and the PVD.
 *
 * Enabled with -DSONGBIRD_IDLE_STOP2=1 on a SONGBIRD_REVA build. Without it
 * every function here is an empty inline and FreeRTOS runs as before.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_LOW_POWER_H
#define SONGBIRD_LOW_POWER_H

#include <Arduino.h>

#if defined(SONGBIRD_REVA) && defined(SONGBIRD_IDLE_STOP2) && (SONGBIRD_IDLE_STOP2 == 1)

#define SONGBIRD_LOW_POWER_ENABLED 1

/**
 * @brief Set up LSI, LPTIM1 and the ATTN interrupt, and self-test the timer
 *
 * Call from setup() after the console is up and before the scheduler starts.
 * If the timer self-test fails, Stop 2 stays disabled and the system runs
 * with ordinary idle sleep.
 */
void lowPowerInit(void);

/**
 * @brief Hold off Stop 2 while the buzzer PWM is running
 *
 * TIM1 has no clock in Stop 2, so a note in progress would be cut short.
 */
void lowPowerSetAudioActive(bool active);

/**
 * @brief Print Stop 2 statistics since the previous call (debug console)
 */
void lowPowerLogStats(void);

#else

static inline void lowPowerInit(void) {}
static inline void lowPowerSetAudioActive(bool active) { (void)active; }
static inline void lowPowerLogStats(void) {}

#endif

#endif // SONGBIRD_LOW_POWER_H
