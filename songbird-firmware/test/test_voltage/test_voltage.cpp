/**
 * @file test_voltage.cpp
 * @brief Replay of the host 1.7.3 voltage freeze, missing low_battery, and
 *        false pvd_low_battery notes.
 *
 * Numbers are the 2026-11-05 Notehub IQ verification
 * (repo 6e7ce9f5-4771-4938-8522-5f9b60669db0), not invented fleet data.
 * The production selector is compiled in directly so this does not duplicate
 * the logic under test.
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"
#include "SongbirdVoltage.h"
#include "SongbirdVoltage.cpp"

static VoltageObservation obs(float cardVolts, bool instant, float powerLogVolts,
                              uint32_t nowMs) {
    VoltageObservation o;
    o.cardVolts = cardVolts;
    o.cardInstant = instant;
    o.powerLogVolts = powerLogVolts;
    o.nowMs = nowMs;
    return o;
}

void setUp(void) {}
void tearDown(void) {}

void test_threshold_default_unchanged(void) {
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 3.4f, DEFAULT_VOLTAGE_ALERT_LOW);
}

// songbird-07: sessions stuck at 3.808 V for 37 begins / 575 min while
// notecard_log over Nov 1 00:00–06:00 was avg/min/max 3.493/3.408/3.547.
// That whole band is still above 3.4 V — the defect is reporting 3.808
// instead of the live log. The log moves inside the verified band so it is
// not itself a latched millivolt.
void test_replay_songbird07_freeze_tracks_power_log_not_stuck_card(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    const float logStart = 3.547f;  // verified max
    const float logEnd = 3.408f;    // verified min
    const uint32_t spanMs = 575UL * 60UL * 1000UL;
    const int begins = 37;
    for (int i = 0; i < begins; i++) {
        uint32_t nowMs = (uint32_t)((spanMs / (uint32_t)(begins - 1)) * (uint32_t)i);
        float power = logStart + (logEnd - logStart) * ((float)i / (float)(begins - 1));
        VoltageObservation o = obs(3.808f, true, power, nowMs);
        VoltageDecision d = voltageDecide(&state, &o);

        TEST_ASSERT_TRUE(d.fresh);
        TEST_ASSERT_FLOAT_WITHIN(0.001f, power, d.volts);
        TEST_ASSERT_FALSE(voltageIsLowBattery(3.808f, DEFAULT_VOLTAGE_ALERT_LOW));
        // Verified floor of this window is 3.408 V, still above the default.
        TEST_ASSERT_FALSE(voltageIsLowBattery(d.volts, DEFAULT_VOLTAGE_ALERT_LOW));
    }
}

// Collapse and the 10 first-sync cold boots were 2.896–2.985 V (2.909 at
// 2026-11-01 10:30:56 UTC) with zero alert.qo rows. A latched 3.808 V must
// not hide that fresh sample.
void test_replay_songbird07_collapse_raises_low_battery(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    VoltageObservation freeze = obs(3.808f, true, 3.493f, 0);
    VoltageDecision during = voltageDecide(&state, &freeze);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 3.493f, during.volts);
    TEST_ASSERT_FALSE(voltageIsLowBattery(during.volts, DEFAULT_VOLTAGE_ALERT_LOW));

    VoltageObservation collapse = obs(3.808f, true, 2.909f, 60UL * 1000UL);
    VoltageDecision d = voltageDecide(&state, &collapse);
    TEST_ASSERT_TRUE(d.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 2.909f, d.volts);
    TEST_ASSERT_TRUE(voltageIsLowBattery(d.volts, DEFAULT_VOLTAGE_ALERT_LOW));
    TEST_ASSERT_TRUE(voltageIsLowBattery(2.896f, DEFAULT_VOLTAGE_ALERT_LOW));
    TEST_ASSERT_TRUE(voltageIsLowBattery(2.985f, DEFAULT_VOLTAGE_ALERT_LOW));
}

// songbird-05: sessions stuck at 4.307 V (40 opens / 612 min) while
// notecard_log averaged ~3.866 V. Track the log; do not alert above 3.4 V.
void test_replay_songbird05_plateau_tracks_power_log_without_alert(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    VoltageObservation o = obs(4.307f, true, 3.866f, 0);
    VoltageDecision d = voltageDecide(&state, &o);

    TEST_ASSERT_TRUE(d.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 3.866f, d.volts);
    TEST_ASSERT_FALSE(voltageIsLowBattery(d.volts, DEFAULT_VOLTAGE_ALERT_LOW));
}

// No second source: a millivolt-flat card.voltage must become an explicit
// failure, not a healthy 3.808 V that suppresses low_battery.
void test_flat_card_voltage_without_power_log_is_failure(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    VoltageObservation first = obs(3.808f, true, 0.0f, 0);
    VoltageDecision young = voltageDecide(&state, &first);
    TEST_ASSERT_TRUE(young.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 3.808f, young.volts);

    VoltageObservation later = obs(3.808f, true, 0.0f, VOLTAGE_SAMPLE_STALE_MS);
    VoltageDecision stale = voltageDecide(&state, &later);
    TEST_ASSERT_FALSE(stale.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.0f, stale.volts);
    TEST_ASSERT_FALSE(voltageIsLowBattery(stale.volts, DEFAULT_VOLTAGE_ALERT_LOW));
}

// The 3.808 → 3.806 step is a new latch, not noise. Without a power log it
// is accepted again; it must not be treated as the same frozen sample.
void test_two_millivolt_step_resets_flat_timer(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    VoltageObservation first = obs(3.808f, true, 0.0f, 0);
    voltageDecide(&state, &first);

    VoltageObservation step = obs(3.806f, true, 0.0f, VOLTAGE_SAMPLE_STALE_MS);
    VoltageDecision d = voltageDecide(&state, &step);
    TEST_ASSERT_TRUE(d.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 3.806f, d.volts);
}

// A non-instant (averaged) card.voltage is not a fresh sample when the
// power log is absent.
void test_averaged_card_voltage_is_not_fresh(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    VoltageObservation o = obs(3.808f, false, 0.0f, 0);
    VoltageDecision d = voltageDecide(&state, &o);
    TEST_ASSERT_FALSE(d.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 0.0f, d.volts);
}

// Agreeing young samples keep the instantaneous card reading.
void test_agreeing_samples_use_instant_card_voltage(void) {
    VoltageSampleState state;
    voltageSampleStateInit(&state);

    VoltageObservation o = obs(3.90f, true, 3.88f, 0);
    VoltageDecision d = voltageDecide(&state, &o);
    TEST_ASSERT_TRUE(d.fresh);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 3.90f, d.volts);
    TEST_ASSERT_FALSE(voltageIsLowBattery(d.volts, DEFAULT_VOLTAGE_ALERT_LOW));
}

// songbird-10 4.334 V and songbird-16 4.322 V were pvd_low_battery notes.
// A pack above 4 V must not produce that note, whether or not PVDO is set.
void test_pvd_suppresses_fleet_false_high_voltage(void) {
    const float falseVolts[] = {4.334f, 4.322f, 4.294f, 4.378f};
    for (unsigned i = 0; i < sizeof(falseVolts) / sizeof(falseVolts[0]); i++) {
        float report = 0.0f;
        PvdAction action = voltagePvdAction(falseVolts[i], true, &report);
        TEST_ASSERT_EQUAL(PVD_ACTION_SUPPRESS, action);
    }
}

void test_pvd_reports_fresh_low_sample(void) {
    float report = 0.0f;
    // songbird-07 first-sync cold boots were 2.896–2.985 V; 2.909 was the
    // collapse sample at 2026-11-01 10:30:56 UTC.
    PvdAction action = voltagePvdAction(2.909f, true, &report);
    TEST_ASSERT_EQUAL(PVD_ACTION_SHUTDOWN_REPORT, action);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 2.909f, report);
}

// No pack sample, but VDD is still under the detector: report the rail,
// not a stale 4.3 V left in the caller's buffer.
void test_pvd_failed_sample_reports_rail_not_stale_high(void) {
    float report = 4.334f;
    PvdAction action = voltagePvdAction(0.0f, true, &report);
    TEST_ASSERT_EQUAL(PVD_ACTION_SHUTDOWN_REPORT, action);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, VOLTAGE_PVD_RAIL_V, report);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 2.9f, report);
}

void test_pvd_suppresses_when_rail_recovered(void) {
    float report = 4.334f;
    PvdAction action = voltagePvdAction(2.909f, false, &report);
    TEST_ASSERT_EQUAL(PVD_ACTION_SUPPRESS, action);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, 4.334f, report);
}

void test_low_battery_boundary_matches_default_threshold(void) {
    TEST_ASSERT_TRUE(voltageIsLowBattery(3.399f, DEFAULT_VOLTAGE_ALERT_LOW));
    TEST_ASSERT_FALSE(voltageIsLowBattery(3.4f, DEFAULT_VOLTAGE_ALERT_LOW));
    TEST_ASSERT_FALSE(voltageIsLowBattery(0.0f, DEFAULT_VOLTAGE_ALERT_LOW));
}

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;
    UNITY_BEGIN();
    RUN_TEST(test_threshold_default_unchanged);
    RUN_TEST(test_replay_songbird07_freeze_tracks_power_log_not_stuck_card);
    RUN_TEST(test_replay_songbird07_collapse_raises_low_battery);
    RUN_TEST(test_replay_songbird05_plateau_tracks_power_log_without_alert);
    RUN_TEST(test_flat_card_voltage_without_power_log_is_failure);
    RUN_TEST(test_two_millivolt_step_resets_flat_timer);
    RUN_TEST(test_averaged_card_voltage_is_not_fresh);
    RUN_TEST(test_agreeing_samples_use_instant_card_voltage);
    RUN_TEST(test_pvd_suppresses_fleet_false_high_voltage);
    RUN_TEST(test_pvd_reports_fresh_low_sample);
    RUN_TEST(test_pvd_failed_sample_reports_rail_not_stale_high);
    RUN_TEST(test_pvd_suppresses_when_rail_recovered);
    RUN_TEST(test_low_battery_boundary_matches_default_threshold);
    return UNITY_END();
}
