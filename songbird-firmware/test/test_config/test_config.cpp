/**
 * @file test_config.cpp
 * @brief Unit tests for SongbirdConfig.h constants, macros, and types
 *
 * Tests configuration values, helper macros, and struct definitions
 * from SongbirdConfig.h using PlatformIO Unity on the native platform.
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"

void setUp(void) {}
void tearDown(void) {}

// ============================================================================
// Operating Mode Enum Values
// ============================================================================

void test_mode_enum_values(void) {
    TEST_ASSERT_EQUAL(0, MODE_DEMO);
    TEST_ASSERT_EQUAL(1, MODE_TRANSIT);
    TEST_ASSERT_EQUAL(2, MODE_STORAGE);
    TEST_ASSERT_EQUAL(3, MODE_SLEEP);
}

// ============================================================================
// Command Type Enum Values
// ============================================================================

void test_command_type_enum_values(void) {
    TEST_ASSERT_EQUAL(0, CMD_PING);
    TEST_ASSERT_EQUAL(1, CMD_LOCATE);
    TEST_ASSERT_EQUAL(2, CMD_PLAY_MELODY);
    TEST_ASSERT_EQUAL(3, CMD_TEST_AUDIO);
    TEST_ASSERT_EQUAL(4, CMD_SET_VOLUME);
    TEST_ASSERT_EQUAL(5, CMD_UNLOCK);
    TEST_ASSERT_EQUAL(6, CMD_UNKNOWN);
}

// ============================================================================
// CLAMP Macro
// ============================================================================

void test_clamp_within_range(void) {
    TEST_ASSERT_EQUAL(5, CLAMP(5, 0, 10));
}

void test_clamp_below_minimum(void) {
    TEST_ASSERT_EQUAL(0, CLAMP(-5, 0, 10));
}

void test_clamp_above_maximum(void) {
    TEST_ASSERT_EQUAL(10, CLAMP(15, 0, 10));
}

// ============================================================================
// MINUTES_TO_MS Macro
// ============================================================================

void test_minutes_to_ms_one_minute(void) {
    TEST_ASSERT_EQUAL_UINT32(60000UL, MINUTES_TO_MS(1));
}

void test_minutes_to_ms_five_minutes(void) {
    TEST_ASSERT_EQUAL_UINT32(300000UL, MINUTES_TO_MS(5));
}

// ============================================================================
// HOURS_TO_SEC Macro
// ============================================================================

void test_hours_to_sec_one_hour(void) {
    TEST_ASSERT_EQUAL_UINT32(3600UL, HOURS_TO_SEC(1));
}

void test_hours_to_sec_twenty_four_hours(void) {
    TEST_ASSERT_EQUAL_UINT32(86400UL, HOURS_TO_SEC(24));
}

// ============================================================================
// MIN / MAX Macros
// ============================================================================

void test_min_macro(void) {
    TEST_ASSERT_EQUAL(3, MIN(3, 5));
    TEST_ASSERT_EQUAL(3, MIN(5, 3));
}

void test_max_macro(void) {
    TEST_ASSERT_EQUAL(5, MAX(3, 5));
    TEST_ASSERT_EQUAL(5, MAX(5, 3));
}

// ============================================================================
// Default Configuration Values
// ============================================================================

void test_default_mode_is_demo(void) {
    TEST_ASSERT_EQUAL(MODE_DEMO, DEFAULT_MODE);
}

void test_default_gps_interval(void) {
    TEST_ASSERT_EQUAL(5, DEFAULT_GPS_INTERVAL_MIN);
}

void test_default_sync_interval(void) {
    TEST_ASSERT_EQUAL(15, DEFAULT_SYNC_INTERVAL_MIN);
}

void test_default_heartbeat_hours(void) {
    TEST_ASSERT_EQUAL(24, DEFAULT_HEARTBEAT_HOURS);
}

void test_default_temp_thresholds(void) {
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 35.0f, DEFAULT_TEMP_ALERT_HIGH_C);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, DEFAULT_TEMP_ALERT_LOW_C);
}

// ============================================================================
// SongbirdConfig Struct Size
// ============================================================================

void test_songbird_config_struct_is_nonzero(void) {
    TEST_ASSERT_TRUE(sizeof(SongbirdConfig) > 0);
}

void test_songbird_config_struct_reasonable_size(void) {
    // The struct has ~20 fields of mixed types; should be less than 256 bytes
    TEST_ASSERT_TRUE(sizeof(SongbirdConfig) < 256);
    // But should be at least large enough for the fields we know about
    TEST_ASSERT_TRUE(sizeof(SongbirdConfig) >= 20);
}

// ============================================================================
// Alert Flag Bitmask Uniqueness
// ============================================================================

void test_alert_flags_are_distinct_powers_of_two(void) {
    uint8_t flags[] = {
        ALERT_FLAG_TEMP_HIGH,
        ALERT_FLAG_TEMP_LOW,
        ALERT_FLAG_HUMIDITY_HIGH,
        ALERT_FLAG_HUMIDITY_LOW,
        ALERT_FLAG_PRESSURE_DELTA,
        ALERT_FLAG_LOW_BATTERY,
        ALERT_FLAG_MOTION
    };
    int count = sizeof(flags) / sizeof(flags[0]);

    for (int i = 0; i < count; i++) {
        // Each flag must be a power of 2 (exactly one bit set)
        TEST_ASSERT_TRUE_MESSAGE(flags[i] != 0 && (flags[i] & (flags[i] - 1)) == 0,
                                 "Alert flag is not a power of 2");
    }

    // All flags must be unique (OR of all should have exactly count bits set)
    uint8_t combined = 0;
    for (int i = 0; i < count; i++) {
        TEST_ASSERT_EQUAL_MESSAGE(0, combined & flags[i],
                                  "Duplicate alert flag detected");
        combined |= flags[i];
    }
}

// ============================================================================
// Sensor Interval Sanity
// ============================================================================

void test_sensor_interval_demo_less_than_storage(void) {
    TEST_ASSERT_TRUE(SENSOR_INTERVAL_DEMO_MS <= SENSOR_INTERVAL_STORAGE_MS);
}

void test_sensor_interval_transit_less_than_storage(void) {
    TEST_ASSERT_TRUE(SENSOR_INTERVAL_TRANSIT_MS <= SENSOR_INTERVAL_STORAGE_MS);
}

// ============================================================================
// Main
// ============================================================================

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // Operating modes
    RUN_TEST(test_mode_enum_values);

    // Command types
    RUN_TEST(test_command_type_enum_values);

    // CLAMP macro
    RUN_TEST(test_clamp_within_range);
    RUN_TEST(test_clamp_below_minimum);
    RUN_TEST(test_clamp_above_maximum);

    // MINUTES_TO_MS macro
    RUN_TEST(test_minutes_to_ms_one_minute);
    RUN_TEST(test_minutes_to_ms_five_minutes);

    // HOURS_TO_SEC macro
    RUN_TEST(test_hours_to_sec_one_hour);
    RUN_TEST(test_hours_to_sec_twenty_four_hours);

    // MIN / MAX macros
    RUN_TEST(test_min_macro);
    RUN_TEST(test_max_macro);

    // Default configuration values
    RUN_TEST(test_default_mode_is_demo);
    RUN_TEST(test_default_gps_interval);
    RUN_TEST(test_default_sync_interval);
    RUN_TEST(test_default_heartbeat_hours);
    RUN_TEST(test_default_temp_thresholds);

    // Struct size
    RUN_TEST(test_songbird_config_struct_is_nonzero);
    RUN_TEST(test_songbird_config_struct_reasonable_size);

    // Alert flag bitmasks
    RUN_TEST(test_alert_flags_are_distinct_powers_of_two);

    // Sensor intervals
    RUN_TEST(test_sensor_interval_demo_less_than_storage);
    RUN_TEST(test_sensor_interval_transit_less_than_storage);

    return UNITY_END();
}
