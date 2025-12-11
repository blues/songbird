/**
 * @file SongbirdCommands.h
 * @brief Command handling interface for Songbird
 *
 * Processes inbound commands from cloud via command.qi Notefile.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_COMMANDS_H
#define SONGBIRD_COMMANDS_H

#include <Arduino.h>
#include "SongbirdConfig.h"
#include "SongbirdSync.h"  // For AudioEventType

// =============================================================================
// Command Module Interface
// =============================================================================

/**
 * @brief Execute a command
 *
 * Dispatches command to appropriate handler and returns result.
 * May queue audio events for playback.
 *
 * @param cmd Command to execute
 * @param config Current device configuration
 * @param ack Pointer to CommandAck structure to fill with result
 * @return true if command executed (check ack->status for result)
 */
bool commandsExecute(const Command* cmd, const SongbirdConfig* config, CommandAck* ack);

/**
 * @brief Get command type from string name
 *
 * @param name Command name string
 * @return CommandType enum value
 */
CommandType commandsParseType(const char* name);

/**
 * @brief Get command name string from type
 *
 * @param type Command type
 * @return Command name string
 */
const char* commandsGetTypeName(CommandType type);

// =============================================================================
// Individual Command Handlers
// =============================================================================

/**
 * @brief Handle ping command
 *
 * Plays notification chime.
 *
 * @param cmd Command (unused for ping)
 * @param config Current configuration
 * @param ack Acknowledgment to fill
 */
void commandsHandlePing(const Command* cmd, const SongbirdConfig* config, CommandAck* ack);

/**
 * @brief Handle locate command
 *
 * Starts repeating "find me" audio pattern.
 *
 * @param cmd Command with duration parameter
 * @param config Current configuration
 * @param ack Acknowledgment to fill
 */
void commandsHandleLocate(const Command* cmd, const SongbirdConfig* config, CommandAck* ack);

/**
 * @brief Handle play_melody command
 *
 * Plays a named melody.
 *
 * @param cmd Command with melody name parameter
 * @param config Current configuration
 * @param ack Acknowledgment to fill
 */
void commandsHandlePlayMelody(const Command* cmd, const SongbirdConfig* config, CommandAck* ack);

/**
 * @brief Handle test_audio command
 *
 * Plays a test tone at specified frequency.
 *
 * @param cmd Command with frequency and duration parameters
 * @param config Current configuration
 * @param ack Acknowledgment to fill
 */
void commandsHandleTestAudio(const Command* cmd, const SongbirdConfig* config, CommandAck* ack);

/**
 * @brief Handle set_volume command
 *
 * Temporarily sets audio volume.
 *
 * @param cmd Command with volume parameter
 * @param config Current configuration
 * @param ack Acknowledgment to fill
 */
void commandsHandleSetVolume(const Command* cmd, const SongbirdConfig* config, CommandAck* ack);

// =============================================================================
// Melody Name Lookup
// =============================================================================

/**
 * @brief Get audio event type for melody name
 *
 * @param name Melody name ("connected", "alert", "power_on", etc.)
 * @return AudioEventType, or AUDIO_EVENT_ERROR if not found
 */
AudioEventType commandsGetMelodyEvent(const char* name);

#endif // SONGBIRD_COMMANDS_H
