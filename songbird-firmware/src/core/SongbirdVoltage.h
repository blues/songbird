/**
 * @file SongbirdVoltage.h
 * @brief Host voltage sample selection for alerts and brownout notes
 *
 * card.voltage's `value` is a trailing 15-minute average unless the request
 * sets `now: true`. On host 1.7.3 that average stayed millivolt-flat for
 * hours (songbird-07 sessions at 3.808 V for 575 min) while Mojo `_log.qo`
 * (`card.power`) kept falling through the 3.4 V alert band. Alerts and
 * pvd_low_battery notes were comparing that flat sample.
 *
 * voltageDecide() returns a fresh sample, or 0 when the only reading is a
 * stuck value. Callers must not treat 0 as a healthy pack.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_VOLTAGE_H
#define SONGBIRD_VOLTAGE_H

#include <stdint.h>
#include <stdbool.h>

// A card.voltage or card.power reading that does not move by at least this
// much is the same latched millivolt, not a new ADC sample.
#define VOLTAGE_SAMPLE_FLAT_EPSILON_V  0.0015f

// card.voltage vs card.power disagreement that means they are not the same
// live pack reading. Fleet freezes were ~0.30 V (songbird-07) and ~0.44 V
// (songbird-05).
#define VOLTAGE_SAMPLE_DIVERGENCE_V    0.15f

// Longer than card.voltage's 15-minute average window. A live ADC jitters;
// a value that is still millivolt-flat after this is the stuck sample.
#define VOLTAGE_SAMPLE_STALE_MS        (20UL * 60UL * 1000UL)

// Pack readings at or above this cannot be a PVD trip. PVD level 6 is ~2.9 V.
// Fleet pvd_low_battery notes reported 4.294–4.378 V.
#define VOLTAGE_PVD_FALSE_ABOVE_V      4.0f

// Voltage reported when PVD is still asserted and no fresh pack sample exists.
// Matches PVD_SHUTDOWN_LEVEL (PWR_PVDLEVEL_6, ~2.9 V). Not a guessed pack voltage.
#define VOLTAGE_PVD_RAIL_V             2.9f

typedef struct {
    float lastVolts;
    uint32_t lastChangeMs;
    bool haveLast;
} VoltageFlatTracker;

typedef struct {
    VoltageFlatTracker card;
    VoltageFlatTracker power;
} VoltageSampleState;

typedef struct {
    float cardVolts;       // card.voltage value, or 0 if the request failed
    bool cardInstant;      // true only when the request used now:true and succeeded
    float powerLogVolts;   // card.power voltage (Mojo / _log.qo), or 0 if absent
    uint32_t nowMs;
} VoltageObservation;

typedef struct {
    float volts;           // 0 = explicit failure; do not use as a pack voltage
    bool fresh;
} VoltageDecision;

typedef enum {
    PVD_ACTION_SUPPRESS = 0,
    PVD_ACTION_SHUTDOWN_REPORT = 1
} PvdAction;

void voltageSampleStateInit(VoltageSampleState* state);

/**
 * @brief Choose the host voltage for alerts and shutdown notes
 *
 * A moving card.power sample wins when card.voltage is missing, not
 * instantaneous, millivolt-flat, or diverges from it. When both are young
 * and disagree, the lower one is used so a stuck high card.voltage cannot
 * hide a live pack that is already under voltageAlertLow. When the only
 * sample has been millivolt-flat for VOLTAGE_SAMPLE_STALE_MS, the result
 * is a failure (0).
 */
VoltageDecision voltageDecide(VoltageSampleState* state,
                              const VoltageObservation* obs);

/** True when a fresh sample should raise ALERT_FLAG_LOW_BATTERY. */
bool voltageIsLowBattery(float volts, float threshold);

/**
 * @brief Decide whether a PVD interrupt may send pvd_low_battery
 *
 * Suppress when VDD has recovered, or when the fresh pack sample is above
 * VOLTAGE_PVD_FALSE_ABOVE_V (the >4 V notes). When VDD is still below the
 * PVD threshold and no fresh sample exists, report VOLTAGE_PVD_RAIL_V
 * instead of a stale high card.voltage.
 *
 * @param reportVolts Output: voltage to put on the health note. Untouched
 *                    when the action is suppress. May be NULL.
 */
PvdAction voltagePvdAction(float freshVolts, bool vddStillLow,
                           float* reportVolts);

#endif // SONGBIRD_VOLTAGE_H
