/**
 * @file SongbirdCommands.cpp
 * @brief Command handling implementation
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdCommands.h"
#include "SongbirdAudio.h"
#include "SongbirdSync.h"
#include "SongbirdState.h"

// =============================================================================
// Command Type Names
// =============================================================================

static const char* const COMMAND_NAMES[] = {
    "ping",
    "locate",
    "play_melody",
    "test_audio",
    "set_volume",
    "unlock",
    "unknown"
};

// =============================================================================
// Melody Name Mapping
// =============================================================================

typedef struct {
    const char* name;
    AudioEventType event;
} MelodyMapping;

static const MelodyMapping MELODY_MAPPINGS[] = {
    {"connected", AUDIO_EVENT_CONNECTED},
    {"power_on", AUDIO_EVENT_POWER_ON},
    {"alert", AUDIO_EVENT_TEMP_ALERT},
    {"ping", AUDIO_EVENT_PING},
    {"error", AUDIO_EVENT_ERROR},
    {"low_battery", AUDIO_EVENT_LOW_BATTERY},
    {"gps_lock", AUDIO_EVENT_GPS_LOCK},
    {"sleep", AUDIO_EVENT_SLEEP},
    {NULL, AUDIO_EVENT_ERROR}  // Terminator
};

// =============================================================================
// Command Execution
// =============================================================================

bool commandsExecute(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    if (cmd == NULL || ack == NULL) {
        return false;
    }

    // Initialize ack
    memset(ack, 0, sizeof(CommandAck));
    strncpy(ack->commandId, cmd->commandId, sizeof(ack->commandId) - 1);
    ack->type = cmd->type;
    ack->executedAt = millis() / 1000;  // Would use RTC in production

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Commands] Executing: ");
    DEBUG_SERIAL.println(commandsGetTypeName(cmd->type));
    #endif

    // Dispatch to handler
    switch (cmd->type) {
        case CMD_PING:
            commandsHandlePing(cmd, config, ack);
            break;

        case CMD_LOCATE:
            commandsHandleLocate(cmd, config, ack);
            break;

        case CMD_PLAY_MELODY:
            commandsHandlePlayMelody(cmd, config, ack);
            break;

        case CMD_TEST_AUDIO:
            commandsHandleTestAudio(cmd, config, ack);
            break;

        case CMD_SET_VOLUME:
            commandsHandleSetVolume(cmd, config, ack);
            break;

        case CMD_UNLOCK:
            commandsHandleUnlock(cmd, config, ack);
            break;

        default:
            ack->status = CMD_STATUS_ERROR;
            strncpy(ack->message, "Unknown command", sizeof(ack->message) - 1);
            return true;
    }

    return true;
}

// =============================================================================
// Type Parsing
// =============================================================================

CommandType commandsParseType(const char* name) {
    if (name == NULL) {
        return CMD_UNKNOWN;
    }

    for (int i = 0; i < CMD_UNKNOWN; i++) {
        if (strcmp(name, COMMAND_NAMES[i]) == 0) {
            return (CommandType)i;
        }
    }

    return CMD_UNKNOWN;
}

const char* commandsGetTypeName(CommandType type) {
    if (type <= CMD_UNKNOWN) {
        return COMMAND_NAMES[type];
    }
    return COMMAND_NAMES[CMD_UNKNOWN];
}

// =============================================================================
// Individual Command Handlers
// =============================================================================

void commandsHandlePing(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    (void)cmd;     // Unused
    (void)config;  // Use audioIsEnabled() instead for reliability

    if (!audioIsEnabled()) {
        ack->status = CMD_STATUS_IGNORED;
        strncpy(ack->message, "Audio disabled", sizeof(ack->message) - 1);
        return;
    }

    // Queue ping audio event
    if (audioQueueEvent(AUDIO_EVENT_PING)) {
        ack->status = CMD_STATUS_OK;
        strncpy(ack->message, "Ping played", sizeof(ack->message) - 1);
    } else {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Failed to queue audio", sizeof(ack->message) - 1);
    }
}

void commandsHandleLocate(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    if (!audioIsEnabled()) {
        ack->status = CMD_STATUS_IGNORED;
        strncpy(ack->message, "Audio disabled", sizeof(ack->message) - 1);
        return;
    }

    uint16_t duration = cmd->params.locate.durationSec;
    if (duration == 0) {
        duration = config->locateDurationSec;
    }

    // Clamp duration
    duration = CLAMP(duration, 5, 300);

    // Start locate mode
    if (audioStartLocate(duration)) {
        ack->status = CMD_STATUS_OK;
        snprintf(ack->message, sizeof(ack->message),
                 "Locate started for %d seconds", duration);
    } else {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Failed to start locate", sizeof(ack->message) - 1);
    }
}

void commandsHandlePlayMelody(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    (void)config;  // Use audioIsEnabled() instead for reliability

    if (!audioIsEnabled()) {
        ack->status = CMD_STATUS_IGNORED;
        strncpy(ack->message, "Audio disabled", sizeof(ack->message) - 1);
        return;
    }

    // Look up melody
    AudioEventType event = commandsGetMelodyEvent(cmd->params.playMelody.melodyName);

    if (event == AUDIO_EVENT_ERROR && strcmp(cmd->params.playMelody.melodyName, "error") != 0) {
        ack->status = CMD_STATUS_ERROR;
        snprintf(ack->message, sizeof(ack->message),
                 "Unknown melody: %s", cmd->params.playMelody.melodyName);
        return;
    }

    // Queue melody
    if (audioQueueEvent(event)) {
        ack->status = CMD_STATUS_OK;
        snprintf(ack->message, sizeof(ack->message),
                 "Playing melody: %s", cmd->params.playMelody.melodyName);
    } else {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Failed to queue melody", sizeof(ack->message) - 1);
    }
}

void commandsHandleTestAudio(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    (void)config;  // Use audioIsEnabled() instead for reliability

    if (!audioIsEnabled()) {
        ack->status = CMD_STATUS_IGNORED;
        strncpy(ack->message, "Audio disabled", sizeof(ack->message) - 1);
        return;
    }

    uint16_t frequency = cmd->params.testAudio.frequency;
    uint16_t duration = cmd->params.testAudio.durationMs;

    // Validate parameters
    if (frequency < 100 || frequency > 10000) {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Frequency must be 100-10000 Hz", sizeof(ack->message) - 1);
        return;
    }

    if (duration < 50 || duration > 5000) {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Duration must be 50-5000 ms", sizeof(ack->message) - 1);
        return;
    }

    // Queue custom tone
    if (audioQueueTone(frequency, duration)) {
        ack->status = CMD_STATUS_OK;
        snprintf(ack->message, sizeof(ack->message),
                 "Playing %dHz for %dms", frequency, duration);
    } else {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Failed to queue tone", sizeof(ack->message) - 1);
    }
}

void commandsHandleSetVolume(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    (void)config;  // Volume change works even if audio currently disabled

    uint8_t volume = cmd->params.setVolume.volume;

    if (volume > 100) {
        ack->status = CMD_STATUS_ERROR;
        strncpy(ack->message, "Volume must be 0-100", sizeof(ack->message) - 1);
        return;
    }

    // Set volume directly (not persisted - use env var for permanent change)
    audioSetVolume(volume);

    ack->status = CMD_STATUS_OK;
    snprintf(ack->message, sizeof(ack->message),
             "Volume set to %d%%", volume);

    // Play confirmation beep at new volume
    audioQueueEvent(AUDIO_EVENT_PING);
}

void commandsHandleUnlock(const Command* cmd, const SongbirdConfig* config, CommandAck* ack) {
    (void)config;  // Unused

    uint8_t lockType = cmd->params.unlock.lockType;
    bool clearedTransit = false;
    bool clearedDemo = false;

    // Lock type: 0=transit, 1=demo, 2=all
    if (lockType == 0 || lockType == 2) {
        if (stateIsTransitLocked()) {
            stateSetTransitLock(false, MODE_DEMO);  // Previous mode doesn't matter when unlocking
            clearedTransit = true;
        }
    }

    if (lockType == 1 || lockType == 2) {
        if (stateIsDemoLocked()) {
            stateSetDemoLock(false, MODE_DEMO);
            clearedDemo = true;
        }
    }

    // Update lock LED
    stateUpdateLockLED();

    if (clearedTransit || clearedDemo) {
        // Play confirmation sound
        audioQueueEvent(AUDIO_EVENT_PING);

        ack->status = CMD_STATUS_OK;
        if (clearedTransit && clearedDemo) {
            strncpy(ack->message, "Cleared transit and demo locks", sizeof(ack->message) - 1);
        } else if (clearedTransit) {
            strncpy(ack->message, "Cleared transit lock", sizeof(ack->message) - 1);
        } else {
            strncpy(ack->message, "Cleared demo lock", sizeof(ack->message) - 1);
        }
    } else {
        ack->status = CMD_STATUS_IGNORED;
        strncpy(ack->message, "No lock was active", sizeof(ack->message) - 1);
    }
}

// =============================================================================
// Melody Lookup
// =============================================================================

AudioEventType commandsGetMelodyEvent(const char* name) {
    if (name == NULL) {
        return AUDIO_EVENT_ERROR;
    }

    for (const MelodyMapping* m = MELODY_MAPPINGS; m->name != NULL; m++) {
        if (strcmp(name, m->name) == 0) {
            return m->event;
        }
    }

    return AUDIO_EVENT_ERROR;
}
