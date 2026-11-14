/**
 * @file SongbirdVoltage.cpp
 * @brief Pure voltage-sample selection. No hardware dependencies.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdVoltage.h"

#include <math.h>
#include <string.h>

void voltageSampleStateInit(VoltageSampleState* state) {
    if (state == NULL) {
        return;
    }
    memset(state, 0, sizeof(*state));
}

// True when `volts` is still the same latched millivolt after the stale window.
// A failed read (volts <= 0) does not move the tracker.
static bool trackerNote(VoltageFlatTracker* tracker, float volts, uint32_t nowMs) {
    if (tracker == NULL || volts <= 0.0f) {
        return false;
    }

    if (!tracker->haveLast ||
        fabsf(volts - tracker->lastVolts) >= VOLTAGE_SAMPLE_FLAT_EPSILON_V) {
        tracker->lastVolts = volts;
        tracker->lastChangeMs = nowMs;
        tracker->haveLast = true;
        return false;
    }

    return (nowMs - tracker->lastChangeMs) >= VOLTAGE_SAMPLE_STALE_MS;
}

VoltageDecision voltageDecide(VoltageSampleState* state,
                              const VoltageObservation* obs) {
    VoltageDecision decision;
    decision.volts = 0.0f;
    decision.fresh = false;

    if (state == NULL || obs == NULL) {
        return decision;
    }

    bool cardStale = trackerNote(&state->card, obs->cardVolts, obs->nowMs);
    bool powerStale = trackerNote(&state->power, obs->powerLogVolts, obs->nowMs);

    // A non-instant card.voltage is the 15-minute average. Do not treat it
    // as a fresh pack reading.
    bool haveCard = obs->cardVolts > 0.0f && obs->cardInstant && !cardStale;
    bool havePower = obs->powerLogVolts > 0.0f && !powerStale;
    bool diverged = haveCard && havePower &&
        fabsf(obs->cardVolts - obs->powerLogVolts) >= VOLTAGE_SAMPLE_DIVERGENCE_V;

    if (haveCard && havePower && diverged) {
        decision.volts = (obs->cardVolts < obs->powerLogVolts)
            ? obs->cardVolts
            : obs->powerLogVolts;
        decision.fresh = true;
        return decision;
    }

    if (havePower && !haveCard) {
        decision.volts = obs->powerLogVolts;
        decision.fresh = true;
        return decision;
    }

    if (haveCard) {
        decision.volts = obs->cardVolts;
        decision.fresh = true;
        return decision;
    }

    return decision;
}

bool voltageIsLowBattery(float volts, float threshold) {
    return volts > 0.0f && volts < threshold;
}

PvdAction voltagePvdAction(float freshVolts, bool vddStillLow,
                           float* reportVolts) {
    if (!vddStillLow) {
        return PVD_ACTION_SUPPRESS;
    }

    // A pack still above 4 V did not trip a ~2.9 V detector. Sending
    // pvd_low_battery here is the songbird-10 / songbird-16 false note.
    if (freshVolts > VOLTAGE_PVD_FALSE_ABOVE_V) {
        return PVD_ACTION_SUPPRESS;
    }

    float report = freshVolts;
    if (report <= 0.0f) {
        report = VOLTAGE_PVD_RAIL_V;
    }

    if (reportVolts != NULL) {
        *reportVolts = report;
    }
    return PVD_ACTION_SHUTDOWN_REPORT;
}
