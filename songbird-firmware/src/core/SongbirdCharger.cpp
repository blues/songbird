/**
 * @file SongbirdCharger.cpp
 * @brief BQ25628E charger status for the Songbird Rev A carrier
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdCharger.h"

#ifdef SONGBIRD_REVA

#include <Wire.h>

// Register addresses (SLUSFA4C table 8-6)
#define BQ_REG_STATUS_0         0x1D
#define BQ_REG_STATUS_1         0x1E
#define BQ_REG_FAULT_0          0x1F
#define BQ_REG_ADC_CONTROL      0x26
#define BQ_REG_VBAT_ADC         0x30    // 16 bit, little endian
#define BQ_REG_PART_INFO        0x38

// REG0x26: ADC_EN (bit 7), ADC_RATE one-shot (bit 6), ADC_SAMPLE left at its
// reset value of 11b (bits 5:4, 9-bit effective resolution).
#define BQ_ADC_ONE_SHOT         0xF0
#define BQ_ADC_EN               0x80

// REG0x38: PN in bits 5:3, 4h = BQ25628E
#define BQ_PART_NUMBER_MASK     0x38
#define BQ_PART_NUMBER_25628E   0x20

static bool s_present = false;

static bool readRegs(uint8_t reg, uint8_t* buf, uint8_t len) {
    Wire.beginTransmission((uint8_t)BOARD_CHARGER_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) {
        return false;
    }
    if (Wire.requestFrom((uint8_t)BOARD_CHARGER_ADDR, len) != len) {
        return false;
    }
    for (uint8_t i = 0; i < len; i++) {
        buf[i] = (uint8_t)Wire.read();
    }
    return true;
}

static bool writeReg(uint8_t reg, uint8_t value) {
    Wire.beginTransmission((uint8_t)BOARD_CHARGER_ADDR);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

bool chargerInit(void) {
    uint8_t part = 0;
    s_present = readRegs(BQ_REG_PART_INFO, &part, 1) &&
                ((part & BQ_PART_NUMBER_MASK) == BQ_PART_NUMBER_25628E);
    return s_present;
}

bool chargerRead(ChargerStatus* status) {
    if (status == NULL || !s_present) {
        return false;
    }

    uint8_t regs[3];
    if (!readRegs(BQ_REG_STATUS_0, regs, 3)) {
        return false;
    }

    status->status0     = regs[0];
    status->chargeState = (ChargeState)((regs[1] >> 3) & 0x03);
    status->vbusPresent = (regs[1] & 0x07) != 0;
    status->fault       = regs[2];
    status->tsZone      = regs[2] & 0x07;
    status->statPinLow  = (digitalRead(BOARD_CHG_STAT_PIN) == LOW);
    return true;
}

uint16_t chargerReadBatteryMv(void) {
    if (!s_present) {
        return 0;
    }

    if (!writeReg(BQ_REG_ADC_CONTROL, BQ_ADC_ONE_SHOT)) {
        return 0;
    }

    // The charger clears ADC_EN when a one-shot conversion completes. It also
    // refuses to set it when neither VBUS nor VBAT is high enough to run the
    // ADC, in which case the loop exits at once and the register still holds
    // its previous reading (zero after power-on).
    uint8_t ctrl = BQ_ADC_EN;
    for (uint8_t i = 0; i < 30; i++) {
        delay(5);
        if (!readRegs(BQ_REG_ADC_CONTROL, &ctrl, 1)) {
            return 0;
        }
        if ((ctrl & BQ_ADC_EN) == 0) {
            break;
        }
    }
    if (ctrl & BQ_ADC_EN) {
        return 0;
    }

    uint8_t raw[2];
    if (!readRegs(BQ_REG_VBAT_ADC, raw, 2)) {
        return 0;
    }

    // VBAT_ADC is bits 12:1, 1.99 mV per step.
    uint32_t code = ((((uint16_t)raw[1] << 8) | raw[0]) >> 1) & 0x0FFF;
    return (uint16_t)((code * 199U) / 100U);
}

void chargerSetInhibit(bool inhibit) {
    if (inhibit) {
        pinMode(BOARD_CHG_CE_PIN, OUTPUT);
        digitalWrite(BOARD_CHG_CE_PIN, HIGH);
    } else {
        pinMode(BOARD_CHG_CE_PIN, INPUT);   // R23 pulls CE low: charging enabled
    }
}

const char* chargerStateName(ChargeState state) {
    switch (state) {
        case CHARGE_STATE_CC:     return "charging (CC)";
        case CHARGE_STATE_CV:     return "charging (CV taper)";
        case CHARGE_STATE_TOPOFF: return "top-off";
        case CHARGE_STATE_NONE:
        default:                  return "not charging";
    }
}

#endif // SONGBIRD_REVA
