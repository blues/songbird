/**
 * @file SongbirdBoardRevA.h
 * @brief Pin and bus definitions for the Songbird Rev A carrier (STM32U575CGT6, LQFP48).
 *
 * Source of truth: songbird-pcb/docs/bringup/PINMAP.md, read from the routed board.
 * Uses the STM32duino generic variant STM32U5xx/U575C(G-I)(T-U)_U585CI(T-U).
 *
 * Every LED on this board is wired anode to +VIO with the MCU sinking the cathode,
 * so all LED outputs are ACTIVE LOW.
 *
 * Copyright (c) 2026 Blues Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef SONGBIRD_BOARD_REVA_H
#define SONGBIRD_BOARD_REVA_H

#include <Arduino.h>

// --- Debug console: USART2 on the STDC14 virtual COM port -------------------
// PA2/PA3 default to LPUART1 in the generic variant; ALT1 selects USART2.
//
// Rev A erratum E4: the two console lines are crossed at J5. PA2 (USART2_TX)
// lands on STDC14 pin 13 and PA3 (USART2_RX) on pin 14, but the probe expects
// the target's RX on 13 and TX on 14. The USART can exchange its TX and RX
// pins internally (CR2.SWAP), so the fix is in firmware: call
// boardRevAConsoleSwap() after every begin() on the console port.
#define BOARD_CONSOLE_TX_PIN    PA2_ALT1
#define BOARD_CONSOLE_RX_PIN    PA3_ALT1
#define BOARD_CONSOLE_BAUD      115200

static inline void boardRevAConsoleSwap(void) {
    USART2->CR1 &= ~USART_CR1_UE;       // SWAP can only change while the USART is disabled
    USART2->CR2 |= USART_CR2_SWAP;
    USART2->CR1 |= USART_CR1_UE;
}

// --- I2C1: Notecard 0x17, BQ25628 0x6A, BME280 0x77 --------------------------
// These are the generic variant's default Wire pins.
#define BOARD_I2C_SDA_PIN       PB3
#define BOARD_I2C_SCL_PIN       PB6
#define BOARD_NOTECARD_ADDR     0x17
#define BOARD_CHARGER_ADDR      0x6A
#define BOARD_BME280_ADDR       0x77

// --- User button SW1 (Omron B3W-9000-RG2N) ----------------------------------
// Contact to GND, external 10k pull-up (R42) and 100 nF (C40). Active low.
#define BOARD_BUTTON_PIN        PC13
#define BOARD_BUTTON_ACTIVE     LOW

// SW1's two LEDs. Names assume the switch sits at 0 degrees; if the bring-up
// diode test shows it at 180 degrees, swap these two definitions.
#define BOARD_BTN_LED_RED_PIN   PB1
#define BOARD_BTN_LED_GREEN_PIN PB2

// --- Status LED LD1 (Wuerth 150141M173100, common anode) --------------------
// Rev A erratum E1: the nets LED_G and LED_B are swapped at the part.
// PB5 (net LED_G, TIM3_CH2) lights BLUE; PB0 (net LED_B, TIM3_CH3) lights GREEN.
#define BOARD_LED_RED_PIN       PB4         // TIM3_CH1
#define BOARD_LED_GREEN_PIN     PB0_ALT1    // TIM3_CH3 (ALT1; default maps to TIM1_CH2N)
#define BOARD_LED_BLUE_PIN      PB5         // TIM3_CH2
#define BOARD_LED_ON            LOW
#define BOARD_LED_OFF           HIGH

// --- Transducer LS1 through Q1 (low-side MOSFET) ----------------------------
// Drive high to conduct. Must idle LOW or LS1 draws continuous current.
#define BOARD_BUZZER_PIN        PA8         // TIM1_CH1

// --- Notecard --------------------------------------------------------------
#define BOARD_ATTN_PIN          PB7         // rising edge from the Notecard
#define BOARD_DFU_ACTIVE_PIN    PB9         // Notecard AUX: outboard DFU in progress
#define BOARD_AUX_TX_PIN        PA9         // USART1_TX, to Notecard AUX RX
#define BOARD_AUX_RX_PIN        PA10        // USART1_RX, from Notecard AUX TX

// --- Charger (BQ25628) -----------------------------------------------------
// CE is active low and pulled to GND by R23, so charging is enabled with the
// pin left as an input. Drive HIGH to inhibit charging.
#define BOARD_CHG_CE_PIN        PA15
// STAT is open drain: low while charging, high-Z when done or disabled.
#define BOARD_CHG_STAT_PIN      PB8

// --- SysTick priority before the scheduler starts ---------------------------
// The STM32U5 HAL defaults the SysTick interrupt to the LOWEST priority (the
// L4 HAL used on Cygnet defaults it to the highest). Any FreeRTOS critical
// section entered before the scheduler starts leaves BASEPRI raised, by
// design, and the first malloc() does exactly that through the newlib lock.
// With SysTick at the lowest priority it is then masked: millis() freezes and
// delay() never returns. Raising SysTick above the FreeRTOS syscall ceiling
// keeps time running during setup(). The FreeRTOS port sets the SysTick
// priority back to the kernel priority itself when the scheduler starts.
static inline void boardRevAKeepTickAlive(void) {
    HAL_NVIC_SetPriority(SysTick_IRQn, 0, 0);
}

// --- Pin initialisation ----------------------------------------------------
// Call first thing in setup(). Puts every output in its safe state: buzzer
// MOSFET off, all five LED channels off, charging left enabled.
static inline void boardRevAInitPins(void) {
    boardRevAKeepTickAlive();

    pinMode(BOARD_BUZZER_PIN, OUTPUT);
    digitalWrite(BOARD_BUZZER_PIN, LOW);

    pinMode(BOARD_LED_RED_PIN, OUTPUT);
    pinMode(BOARD_LED_GREEN_PIN, OUTPUT);
    pinMode(BOARD_LED_BLUE_PIN, OUTPUT);
    digitalWrite(BOARD_LED_RED_PIN, BOARD_LED_OFF);
    digitalWrite(BOARD_LED_GREEN_PIN, BOARD_LED_OFF);
    digitalWrite(BOARD_LED_BLUE_PIN, BOARD_LED_OFF);

    pinMode(BOARD_BTN_LED_RED_PIN, OUTPUT);
    pinMode(BOARD_BTN_LED_GREEN_PIN, OUTPUT);
    digitalWrite(BOARD_BTN_LED_RED_PIN, BOARD_LED_OFF);
    digitalWrite(BOARD_BTN_LED_GREEN_PIN, BOARD_LED_OFF);

    pinMode(BOARD_ATTN_PIN, INPUT_PULLDOWN);
    pinMode(BOARD_DFU_ACTIVE_PIN, INPUT);
    pinMode(BOARD_CHG_STAT_PIN, INPUT_PULLUP);
    pinMode(BOARD_CHG_CE_PIN, INPUT);       // R23 holds CE low: charging enabled
}

#endif // SONGBIRD_BOARD_REVA_H
