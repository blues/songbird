/**
 * @file test_commands.cpp
 * @brief Native tests for command parsing and melody lookup logic
 *
 * Re-implements the pure lookup functions from SongbirdCommands.cpp
 * to avoid pulling in hardware dependencies.
 */

#include <unity.h>
#include "native_stubs.h"
#include "SongbirdConfig.h"

// =============================================================================
// Local type and data definitions (copied from firmware to avoid hardware deps)
// =============================================================================

// Audio event types (from SongbirdSync.h, which pulls in FreeRTOS)
typedef enum {
    AUDIO_EVENT_POWER_ON = 0,
    AUDIO_EVENT_CONNECTED,
    AUDIO_EVENT_GPS_LOCK,
    AUDIO_EVENT_TEMP_ALERT,
    AUDIO_EVENT_HUMIDITY_ALERT,
    AUDIO_EVENT_LOW_BATTERY,
    AUDIO_EVENT_SLEEP,
    AUDIO_EVENT_ERROR,
    AUDIO_EVENT_PING,
    AUDIO_EVENT_LOCATE_START,
    AUDIO_EVENT_LOCATE_STOP,
    AUDIO_EVENT_CUSTOM_TONE,
    AUDIO_EVENT_TRANSIT_LOCK_ON,
    AUDIO_EVENT_TRANSIT_LOCK_OFF,
    AUDIO_EVENT_DEMO_LOCK_ON,
    AUDIO_EVENT_DEMO_LOCK_OFF,
    AUDIO_EVENT_COUNT
} AudioEventType;

// Command names (from SongbirdCommands.cpp)
static const char* const COMMAND_NAMES[] = {
    "ping", "locate", "play_melody", "test_audio", "set_volume", "unlock", "unknown"
};

static CommandType commandsParseType(const char* name) {
    if (name == NULL) return CMD_UNKNOWN;
    for (int i = 0; i < CMD_UNKNOWN; i++) {
        if (strcmp(name, COMMAND_NAMES[i]) == 0) return (CommandType)i;
    }
    return CMD_UNKNOWN;
}

static const char* commandsGetTypeName(CommandType type) {
    if (type <= CMD_UNKNOWN) return COMMAND_NAMES[type];
    return COMMAND_NAMES[CMD_UNKNOWN];
}

// Melody mappings (from SongbirdCommands.cpp)
typedef struct { const char* name; AudioEventType event; } MelodyMapping;

static const MelodyMapping MELODY_MAPPINGS[] = {
    {"connected", AUDIO_EVENT_CONNECTED},
    {"power_on", AUDIO_EVENT_POWER_ON},
    {"alert", AUDIO_EVENT_TEMP_ALERT},
    {"ping", AUDIO_EVENT_PING},
    {"error", AUDIO_EVENT_ERROR},
    {"low_battery", AUDIO_EVENT_LOW_BATTERY},
    {"gps_lock", AUDIO_EVENT_GPS_LOCK},
    {"sleep", AUDIO_EVENT_SLEEP},
    {NULL, AUDIO_EVENT_ERROR}
};

static AudioEventType commandsGetMelodyEvent(const char* name) {
    if (name == NULL) return AUDIO_EVENT_ERROR;
    for (const MelodyMapping* m = MELODY_MAPPINGS; m->name != NULL; m++) {
        if (strcmp(name, m->name) == 0) return m->event;
    }
    return AUDIO_EVENT_ERROR;
}

// =============================================================================
// Test Setup / Teardown
// =============================================================================

void setUp(void) {}
void tearDown(void) {}

// =============================================================================
// commandsParseType tests
// =============================================================================

void test_parse_type_ping(void) {
    TEST_ASSERT_EQUAL(CMD_PING, commandsParseType("ping"));
}

void test_parse_type_locate(void) {
    TEST_ASSERT_EQUAL(CMD_LOCATE, commandsParseType("locate"));
}

void test_parse_type_play_melody(void) {
    TEST_ASSERT_EQUAL(CMD_PLAY_MELODY, commandsParseType("play_melody"));
}

void test_parse_type_test_audio(void) {
    TEST_ASSERT_EQUAL(CMD_TEST_AUDIO, commandsParseType("test_audio"));
}

void test_parse_type_set_volume(void) {
    TEST_ASSERT_EQUAL(CMD_SET_VOLUME, commandsParseType("set_volume"));
}

void test_parse_type_unlock(void) {
    TEST_ASSERT_EQUAL(CMD_UNLOCK, commandsParseType("unlock"));
}

void test_parse_type_null_returns_unknown(void) {
    TEST_ASSERT_EQUAL(CMD_UNKNOWN, commandsParseType(NULL));
}

void test_parse_type_bogus_returns_unknown(void) {
    TEST_ASSERT_EQUAL(CMD_UNKNOWN, commandsParseType("bogus"));
}

// =============================================================================
// commandsGetTypeName tests
// =============================================================================

void test_get_type_name_ping(void) {
    TEST_ASSERT_EQUAL_STRING("ping", commandsGetTypeName(CMD_PING));
}

void test_get_type_name_locate(void) {
    TEST_ASSERT_EQUAL_STRING("locate", commandsGetTypeName(CMD_LOCATE));
}

void test_get_type_name_unknown(void) {
    TEST_ASSERT_EQUAL_STRING("unknown", commandsGetTypeName(CMD_UNKNOWN));
}

void test_get_type_name_out_of_range(void) {
    TEST_ASSERT_EQUAL_STRING("unknown", commandsGetTypeName((CommandType)99));
}

// =============================================================================
// commandsGetMelodyEvent tests
// =============================================================================

void test_melody_connected(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_CONNECTED, commandsGetMelodyEvent("connected"));
}

void test_melody_power_on(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_POWER_ON, commandsGetMelodyEvent("power_on"));
}

void test_melody_alert(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_TEMP_ALERT, commandsGetMelodyEvent("alert"));
}

void test_melody_ping(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_PING, commandsGetMelodyEvent("ping"));
}

void test_melody_error(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_ERROR, commandsGetMelodyEvent("error"));
}

void test_melody_low_battery(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_LOW_BATTERY, commandsGetMelodyEvent("low_battery"));
}

void test_melody_gps_lock(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_GPS_LOCK, commandsGetMelodyEvent("gps_lock"));
}

void test_melody_sleep(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_SLEEP, commandsGetMelodyEvent("sleep"));
}

void test_melody_null_returns_error(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_ERROR, commandsGetMelodyEvent(NULL));
}

void test_melody_nonexistent_returns_error(void) {
    TEST_ASSERT_EQUAL(AUDIO_EVENT_ERROR, commandsGetMelodyEvent("nonexistent"));
}

// =============================================================================
// Command struct init / bounded-copy tests (H6)
//
// Mirrors the exact fill semantics of notecardGetCommand(): the struct is
// zero-initialized up front, and a cloud-supplied melody name is copied with a
// bounded, always-null-terminated strncpy. notecardGetCommand() itself pulls in
// the Notecard hardware library, so we exercise the pure parse contract here.
// =============================================================================

// Replicates the fixed play_melody fill path.
static void fill_command_from_melody(Command* cmd, const char* melody) {
    memset(cmd, 0, sizeof(*cmd));
    cmd->type = CMD_PLAY_MELODY;
    if (melody) {
        strncpy(cmd->params.playMelody.melodyName, melody,
                sizeof(cmd->params.playMelody.melodyName) - 1);
        cmd->params.playMelody.melodyName[
            sizeof(cmd->params.playMelody.melodyName) - 1] = '\0';
    }
}

void test_command_zero_init_no_melody_key(void) {
    // play_melody with no "melody" key -> melodyName must be empty, not garbage.
    Command cmd;
    memset(&cmd, 0xAA, sizeof(cmd));  // poison the stack slot first
    fill_command_from_melody(&cmd, NULL);
    TEST_ASSERT_EQUAL_CHAR('\0', cmd.params.playMelody.melodyName[0]);
}

void test_command_melody_null_terminated_when_oversized(void) {
    // A >15-char cloud melody name must be truncated AND null-terminated so a
    // downstream strcmp cannot over-read past the buffer.
    Command cmd;
    fill_command_from_melody(&cmd, "this_is_a_very_long_melody_name");
    size_t cap = sizeof(cmd.params.playMelody.melodyName);
    TEST_ASSERT_EQUAL_CHAR('\0', cmd.params.playMelody.melodyName[cap - 1]);
    TEST_ASSERT_EQUAL_UINT(cap - 1, strlen(cmd.params.playMelody.melodyName));
}

void test_command_melody_short_name_copied(void) {
    Command cmd;
    fill_command_from_melody(&cmd, "ping");
    TEST_ASSERT_EQUAL_STRING("ping", cmd.params.playMelody.melodyName);
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char **argv) {
    UNITY_BEGIN();

    // commandsParseType
    RUN_TEST(test_parse_type_ping);
    RUN_TEST(test_parse_type_locate);
    RUN_TEST(test_parse_type_play_melody);
    RUN_TEST(test_parse_type_test_audio);
    RUN_TEST(test_parse_type_set_volume);
    RUN_TEST(test_parse_type_unlock);
    RUN_TEST(test_parse_type_null_returns_unknown);
    RUN_TEST(test_parse_type_bogus_returns_unknown);

    // commandsGetTypeName
    RUN_TEST(test_get_type_name_ping);
    RUN_TEST(test_get_type_name_locate);
    RUN_TEST(test_get_type_name_unknown);
    RUN_TEST(test_get_type_name_out_of_range);

    // commandsGetMelodyEvent
    RUN_TEST(test_melody_connected);
    RUN_TEST(test_melody_power_on);
    RUN_TEST(test_melody_alert);
    RUN_TEST(test_melody_ping);
    RUN_TEST(test_melody_error);
    RUN_TEST(test_melody_low_battery);
    RUN_TEST(test_melody_gps_lock);
    RUN_TEST(test_melody_sleep);
    RUN_TEST(test_melody_null_returns_error);
    RUN_TEST(test_melody_nonexistent_returns_error);

    // Command struct init / bounded-copy (H6)
    RUN_TEST(test_command_zero_init_no_melody_key);
    RUN_TEST(test_command_melody_null_terminated_when_oversized);
    RUN_TEST(test_command_melody_short_name_copied);

    return UNITY_END();
}
