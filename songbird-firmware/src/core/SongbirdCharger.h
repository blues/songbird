/**
 * @file SongbirdCharger.h
 * @brief BQ25628E charger status for the Songbird Rev A carrier
 *
 * Rev A charges from USB through a BQ25628E (U2, I2C 0x6A) with an NVDC power
 * path. The Notecard sits on the charger's system rail, so it never sees VBUS
 * and cannot tell USB power from battery power. This module reads that from
 * the charger instead.
 *
 * It is a status reader. Charging is enabled in hardware (R23 holds CE low)
 * and every charge parameter stays at the value the charger's pins and reset
 * defaults give it. The only register written is ADC control, to request a
 * single battery-voltage conversion.
 *
 * All functions that touch the bus must be called with the I2C mutex held
 * once the scheduler is running.
 *
 * Register numbers and bit positions are from TI SLUSFA4C (BQ25628E),
 * sections 8.6.2.17 to 8.6.2.19, 8.6.2.26, 8.6.2.32 and 8.6.2.34.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_CHARGER_H
#define SONGBIRD_CHARGER_H

#include <Arduino.h>
#include "SongbirdConfig.h"

#ifdef SONGBIRD_REVA

// CHG_STAT field of REG0x1E, bits 4:3
typedef enum {
    CHARGE_STATE_NONE   = 0,    // Not charging, or charge terminated
    CHARGE_STATE_CC     = 1,    // Trickle, pre-charge or fast charge
    CHARGE_STATE_CV     = 2,    // Taper charge
    CHARGE_STATE_TOPOFF = 3     // Top-off timer running
} ChargeState;

typedef struct {
    bool        vbusPresent;    // REG0x1E VBUS_STAT != 0: powered from USB
    ChargeState chargeState;    // REG0x1E CHG_STAT
    uint8_t     status0;        // REG0x1D raw (regulation loops, timers)
    uint8_t     fault;          // REG0x1F raw; bits 7,6,5,3 are faults
    uint8_t     tsZone;         // REG0x1F TS_STAT, bits 2:0
    bool        statPinLow;     // CHG_STAT pin (PB8): low while charging
} ChargerStatus;

// Bits of ChargerStatus.fault that mean something is wrong (TS_STAT excluded)
#define CHARGER_FAULT_MASK      0xE8

/**
 * @brief Confirm the charger answers and is the expected part
 * @return true if REG0x38 reports a BQ25628E
 */
bool chargerInit(void);

/**
 * @brief Read the three status registers and the STAT pin
 * @return true if the bus read succeeded
 */
bool chargerRead(ChargerStatus* status);

/**
 * @brief Battery voltage at the charger's BAT pin, from a one-shot ADC run
 *
 * Unlike card.voltage this is the cell itself, including while USB is
 * supplying the system rail. Blocks for the conversion, up to 150 ms.
 *
 * @return millivolts, or 0 if the conversion did not run
 */
uint16_t chargerReadBatteryMv(void);

/**
 * @brief Inhibit or allow charging through the CE pin (PA15)
 *
 * Nothing calls this yet. It is the hook for design-spec P0-21, a firmware
 * temperature limit on charging, which needs a decision on thresholds first.
 */
void chargerSetInhibit(bool inhibit);

const char* chargerStateName(ChargeState state);

#endif // SONGBIRD_REVA
#endif // SONGBIRD_CHARGER_H
