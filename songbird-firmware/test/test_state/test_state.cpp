/**
 * @file test_state.cpp
 * @brief Native tests for device state management logic
 *
 * Re-implements pure functions from SongbirdState.cpp to avoid
 * hardware dependencies (Notecard, FreeRTOS).
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"
#include <stddef.h>

// =============================================================================
// State structure and constants (from SongbirdState.h)
// =============================================================================

#define STATE_MAGIC   0x534F4E47  // "SONG"
#define STATE_VERSION 4

typedef struct {
    uint32_t magic;
    uint8_t version;
    uint32_t bootCount;
    uint32_t lastSyncTime;
    uint32_t lastGpsFixTime;
    float lastPressure;
    OperatingMode currentMode;
    uint8_t alertsSent;
    bool motionSinceLastReport;
    uint32_t uptimeAtSleep;
    uint32_t totalUptimeSec;
    bool transitLocked;
    OperatingMode preTransitMode;
    bool demoLocked;
    OperatingMode preDemoMode;

    // GPS Power Management
    bool gpsPowerSaving;
    bool gpsWasActive;
    uint32_t gpsActiveStartTime;
    uint32_t lastGpsRetryTime;

    uint8_t reserved[1];
    uint32_t checksum;
} SongbirdState;

// =============================================================================
// Re-implemented pure functions from SongbirdState.cpp
// =============================================================================

static SongbirdState s_state;
static bool s_warmBoot = false;
static uint32_t s_bootStartTime = 0;

static uint32_t crc32(const uint8_t* data, size_t length) {
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 1) crc = (crc >> 1) ^ 0xEDB88320;
            else crc >>= 1;
        }
    }
    return ~crc;
}

static uint32_t stateCalculateChecksum(const SongbirdState* state) {
    if (state == NULL) return 0;
    size_t checksumOffset = offsetof(SongbirdState, checksum);
    return crc32((const uint8_t*)state, checksumOffset);
}

static bool stateValidateChecksum(const SongbirdState* state) {
    if (state == NULL) return false;
    uint32_t calculated = stateCalculateChecksum(state);
    return calculated == state->checksum;
}

static void stateInit(void) {
    memset(&s_state, 0, sizeof(s_state));
    s_state.magic = STATE_MAGIC;
    s_state.version = STATE_VERSION;
    s_state.bootCount = 1;
    s_state.lastSyncTime = 0;
    s_state.lastGpsFixTime = 0;
    s_state.lastPressure = NAN;
    s_state.currentMode = MODE_DEMO;
    s_state.alertsSent = 0;
    s_state.motionSinceLastReport = false;
    s_state.uptimeAtSleep = 0;
    s_state.totalUptimeSec = 0;
    s_state.transitLocked = false;
    s_state.preTransitMode = MODE_DEMO;
    s_state.demoLocked = false;
    s_state.preDemoMode = MODE_DEMO;
    s_state.gpsPowerSaving = false;
    s_state.gpsWasActive = false;
    s_state.gpsActiveStartTime = 0;
    s_state.lastGpsRetryTime = 0;
    s_bootStartTime = millis();
    s_warmBoot = false;
}

static SongbirdState* stateGet(void) {
    return &s_state;
}

static bool stateIsWarmBoot(void) {
    return s_warmBoot;
}

static void stateIncrementBootCount(void) {
    s_state.bootCount++;
}

static void stateSetMode(OperatingMode mode) {
    s_state.currentMode = mode;
}

static void stateSetAlert(uint8_t alertFlag) {
    s_state.alertsSent |= alertFlag;
}

static void stateClearAlert(uint8_t alertFlag) {
    s_state.alertsSent &= ~alertFlag;
}

static uint8_t stateGetAlerts(void) {
    return s_state.alertsSent;
}

static void stateSetMotion(bool motion) {
    if (motion) {
        s_state.motionSinceLastReport = true;
    }
}

static bool stateGetAndClearMotion(void) {
    bool motion = s_state.motionSinceLastReport;
    s_state.motionSinceLastReport = false;
    return motion;
}

static uint32_t stateGetTotalUptimeSec(void) {
    uint32_t currentSession = (millis() - s_bootStartTime) / 1000;
    return s_state.totalUptimeSec + currentSession;
}

static uint32_t stateGetBootCount(void) {
    return s_state.bootCount;
}

static void stateSetTransitLock(bool locked, OperatingMode previousMode) {
    s_state.transitLocked = locked;
    if (locked) {
        s_state.preTransitMode = previousMode;
    }
}

static bool stateIsTransitLocked(void) {
    return s_state.transitLocked;
}

static OperatingMode stateGetPreTransitMode(void) {
    return s_state.preTransitMode;
}

static void stateSetDemoLock(bool locked, OperatingMode previousMode) {
    s_state.demoLocked = locked;
    if (locked) {
        s_state.preDemoMode = previousMode;
    }
}

static bool stateIsDemoLocked(void) {
    return s_state.demoLocked;
}

static OperatingMode stateGetPreDemoMode(void) {
    return s_state.preDemoMode;
}

static void stateUpdateLockLED(void) {
    bool lockActive = s_state.transitLocked || s_state.demoLocked;
    digitalWrite(LOCK_LED_PIN, lockActive ? HIGH : LOW);
}

// GPS Power Management
static void stateSetGpsPowerSaving(bool enabled) {
    s_state.gpsPowerSaving = enabled;
}

static bool stateIsGpsPowerSaving(void) {
    return s_state.gpsPowerSaving;
}

static void stateSetLastGpsRetryTime(uint32_t time) {
    s_state.lastGpsRetryTime = time;
}

static uint32_t stateGetLastGpsRetryTime(void) {
    return s_state.lastGpsRetryTime;
}

static void stateSetGpsWasActive(bool active) {
    s_state.gpsWasActive = active;
}

static bool stateGetGpsWasActive(void) {
    return s_state.gpsWasActive;
}

static void stateSetGpsActiveStartTime(uint32_t time) {
    s_state.gpsActiveStartTime = time;
}

static uint32_t stateGetGpsActiveStartTime(void) {
    return s_state.gpsActiveStartTime;
}

// =============================================================================
// Test Setup / Teardown
// =============================================================================

void setUp(void) {
    mock_set_millis(0);
    stateInit();
}

void tearDown(void) {}

// =============================================================================
// CRC32 / Checksum tests
// =============================================================================

void test_checksum_nonzero_for_initialized_state(void) {
    uint32_t checksum = stateCalculateChecksum(&s_state);
    TEST_ASSERT_NOT_EQUAL(0, checksum);
}

void test_checksum_validates_correctly(void) {
    s_state.checksum = stateCalculateChecksum(&s_state);
    TEST_ASSERT_TRUE(stateValidateChecksum(&s_state));
}

void test_checksum_detects_corruption(void) {
    s_state.checksum = stateCalculateChecksum(&s_state);
    s_state.bootCount = 9999;  // corrupt a field
    TEST_ASSERT_FALSE(stateValidateChecksum(&s_state));
}

void test_checksum_returns_zero_for_null(void) {
    TEST_ASSERT_EQUAL_UINT32(0, stateCalculateChecksum(NULL));
}

// =============================================================================
// State Init tests
// =============================================================================

void test_init_sets_magic(void) {
    TEST_ASSERT_EQUAL_UINT32(STATE_MAGIC, stateGet()->magic);
}

void test_init_sets_version(void) {
    TEST_ASSERT_EQUAL_UINT8(STATE_VERSION, stateGet()->version);
}

void test_init_sets_mode_demo(void) {
    TEST_ASSERT_EQUAL(MODE_DEMO, stateGet()->currentMode);
}

void test_init_sets_boot_count_1(void) {
    TEST_ASSERT_EQUAL_UINT32(1, stateGetBootCount());
}

// =============================================================================
// Mode Management tests
// =============================================================================

void test_set_mode_updates(void) {
    stateSetMode(MODE_TRANSIT);
    TEST_ASSERT_EQUAL(MODE_TRANSIT, stateGet()->currentMode);
}

void test_set_mode_transit_then_back(void) {
    stateSetMode(MODE_TRANSIT);
    TEST_ASSERT_EQUAL(MODE_TRANSIT, stateGet()->currentMode);
    stateSetMode(MODE_DEMO);
    TEST_ASSERT_EQUAL(MODE_DEMO, stateGet()->currentMode);
}

void test_set_mode_storage(void) {
    stateSetMode(MODE_STORAGE);
    TEST_ASSERT_EQUAL(MODE_STORAGE, stateGet()->currentMode);
}

// =============================================================================
// Alert Management tests
// =============================================================================

void test_set_alert_sets_flag(void) {
    stateSetAlert(ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_BITS_HIGH(ALERT_FLAG_TEMP_HIGH, stateGetAlerts());
}

void test_clear_alert_clears_flag(void) {
    stateSetAlert(ALERT_FLAG_TEMP_HIGH);
    stateClearAlert(ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_BITS_LOW(ALERT_FLAG_TEMP_HIGH, stateGetAlerts());
}

void test_multiple_alerts_independent(void) {
    stateSetAlert(ALERT_FLAG_TEMP_HIGH);
    stateSetAlert(ALERT_FLAG_LOW_BATTERY);
    TEST_ASSERT_BITS_HIGH(ALERT_FLAG_TEMP_HIGH, stateGetAlerts());
    TEST_ASSERT_BITS_HIGH(ALERT_FLAG_LOW_BATTERY, stateGetAlerts());
}

void test_get_alerts_returns_bitmask(void) {
    stateSetAlert(ALERT_FLAG_TEMP_HIGH);
    stateSetAlert(ALERT_FLAG_HUMIDITY_HIGH);
    uint8_t expected = ALERT_FLAG_TEMP_HIGH | ALERT_FLAG_HUMIDITY_HIGH;
    TEST_ASSERT_EQUAL_UINT8(expected, stateGetAlerts());
}

void test_clear_one_alert_preserves_others(void) {
    stateSetAlert(ALERT_FLAG_TEMP_HIGH);
    stateSetAlert(ALERT_FLAG_LOW_BATTERY);
    stateClearAlert(ALERT_FLAG_TEMP_HIGH);
    TEST_ASSERT_BITS_LOW(ALERT_FLAG_TEMP_HIGH, stateGetAlerts());
    TEST_ASSERT_BITS_HIGH(ALERT_FLAG_LOW_BATTERY, stateGetAlerts());
}

// =============================================================================
// Motion tests
// =============================================================================

void test_set_motion_true(void) {
    stateSetMotion(true);
    TEST_ASSERT_TRUE(stateGet()->motionSinceLastReport);
}

void test_get_and_clear_motion(void) {
    stateSetMotion(true);
    TEST_ASSERT_TRUE(stateGetAndClearMotion());
    TEST_ASSERT_FALSE(stateGetAndClearMotion());
}

void test_set_motion_false_when_already_false(void) {
    stateSetMotion(false);
    TEST_ASSERT_FALSE(stateGet()->motionSinceLastReport);
}

// =============================================================================
// Lock Management tests
// =============================================================================

void test_transit_lock_enable(void) {
    stateSetTransitLock(true, MODE_DEMO);
    TEST_ASSERT_TRUE(stateIsTransitLocked());
}

void test_transit_lock_saves_previous_mode(void) {
    stateSetMode(MODE_STORAGE);
    stateSetTransitLock(true, MODE_STORAGE);
    TEST_ASSERT_EQUAL(MODE_STORAGE, stateGetPreTransitMode());
}

void test_transit_lock_disable(void) {
    stateSetTransitLock(true, MODE_DEMO);
    stateSetTransitLock(false, MODE_TRANSIT);  // previousMode ignored on unlock
    TEST_ASSERT_FALSE(stateIsTransitLocked());
    // preTransitMode should still be MODE_DEMO (not overwritten on unlock)
    TEST_ASSERT_EQUAL(MODE_DEMO, stateGetPreTransitMode());
}

void test_demo_lock_enable(void) {
    stateSetDemoLock(true, MODE_TRANSIT);
    TEST_ASSERT_TRUE(stateIsDemoLocked());
    TEST_ASSERT_EQUAL(MODE_TRANSIT, stateGetPreDemoMode());
}

void test_demo_lock_disable(void) {
    stateSetDemoLock(true, MODE_STORAGE);
    stateSetDemoLock(false, MODE_TRANSIT);
    TEST_ASSERT_FALSE(stateIsDemoLocked());
    TEST_ASSERT_EQUAL(MODE_STORAGE, stateGetPreDemoMode());
}

void test_both_locks_simultaneous(void) {
    stateSetTransitLock(true, MODE_DEMO);
    stateSetDemoLock(true, MODE_STORAGE);
    TEST_ASSERT_TRUE(stateIsTransitLocked());
    TEST_ASSERT_TRUE(stateIsDemoLocked());
    TEST_ASSERT_EQUAL(MODE_DEMO, stateGetPreTransitMode());
    TEST_ASSERT_EQUAL(MODE_STORAGE, stateGetPreDemoMode());
}

// =============================================================================
// GPS Power Management tests
// =============================================================================

void test_gps_power_saving(void) {
    TEST_ASSERT_FALSE(stateIsGpsPowerSaving());
    stateSetGpsPowerSaving(true);
    TEST_ASSERT_TRUE(stateIsGpsPowerSaving());
    stateSetGpsPowerSaving(false);
    TEST_ASSERT_FALSE(stateIsGpsPowerSaving());
}

void test_gps_last_retry_time(void) {
    TEST_ASSERT_EQUAL_UINT32(0, stateGetLastGpsRetryTime());
    stateSetLastGpsRetryTime(12345);
    TEST_ASSERT_EQUAL_UINT32(12345, stateGetLastGpsRetryTime());
}

void test_gps_was_active(void) {
    TEST_ASSERT_FALSE(stateGetGpsWasActive());
    stateSetGpsWasActive(true);
    TEST_ASSERT_TRUE(stateGetGpsWasActive());
    stateSetGpsWasActive(false);
    TEST_ASSERT_FALSE(stateGetGpsWasActive());
}

void test_gps_active_start_time(void) {
    TEST_ASSERT_EQUAL_UINT32(0, stateGetGpsActiveStartTime());
    stateSetGpsActiveStartTime(99999);
    TEST_ASSERT_EQUAL_UINT32(99999, stateGetGpsActiveStartTime());
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // CRC32 / Checksum
    RUN_TEST(test_checksum_nonzero_for_initialized_state);
    RUN_TEST(test_checksum_validates_correctly);
    RUN_TEST(test_checksum_detects_corruption);
    RUN_TEST(test_checksum_returns_zero_for_null);

    // State Init
    RUN_TEST(test_init_sets_magic);
    RUN_TEST(test_init_sets_version);
    RUN_TEST(test_init_sets_mode_demo);
    RUN_TEST(test_init_sets_boot_count_1);

    // Mode Management
    RUN_TEST(test_set_mode_updates);
    RUN_TEST(test_set_mode_transit_then_back);
    RUN_TEST(test_set_mode_storage);

    // Alert Management
    RUN_TEST(test_set_alert_sets_flag);
    RUN_TEST(test_clear_alert_clears_flag);
    RUN_TEST(test_multiple_alerts_independent);
    RUN_TEST(test_get_alerts_returns_bitmask);
    RUN_TEST(test_clear_one_alert_preserves_others);

    // Motion
    RUN_TEST(test_set_motion_true);
    RUN_TEST(test_get_and_clear_motion);
    RUN_TEST(test_set_motion_false_when_already_false);

    // Lock Management
    RUN_TEST(test_transit_lock_enable);
    RUN_TEST(test_transit_lock_saves_previous_mode);
    RUN_TEST(test_transit_lock_disable);
    RUN_TEST(test_demo_lock_enable);
    RUN_TEST(test_demo_lock_disable);
    RUN_TEST(test_both_locks_simultaneous);

    // GPS Power Management
    RUN_TEST(test_gps_power_saving);
    RUN_TEST(test_gps_last_retry_time);
    RUN_TEST(test_gps_was_active);
    RUN_TEST(test_gps_active_start_time);

    return UNITY_END();
}
