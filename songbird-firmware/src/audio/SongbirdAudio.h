/**
 * @file SongbirdAudio.h
 * @brief Audio/buzzer interface for Songbird
 *
 * Provides non-blocking audio playback via FreeRTOS queue.
 * Other tasks queue audio events; AudioTask handles playback.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_AUDIO_H
#define SONGBIRD_AUDIO_H

#include <Arduino.h>
#include "SongbirdConfig.h"
#include "SongbirdSync.h"
#include "SongbirdMelodies.h"

// =============================================================================
// Audio Module Interface
// =============================================================================

/**
 * @brief Initialize the audio subsystem
 *
 * Configures the buzzer pin for PWM output.
 * Must be called before any audio functions.
 */
void audioInit(void);

/**
 * @brief Play a single tone (blocking)
 *
 * This function blocks until the tone completes.
 * Should only be called from AudioTask or during initialization.
 *
 * @param frequency Tone frequency in Hz (0 for silence/rest)
 * @param durationMs Duration in milliseconds
 * @param volume Volume level 0-100 (affects PWM duty cycle)
 */
void audioPlayTone(uint16_t frequency, uint16_t durationMs, uint8_t volume);

/**
 * @brief Play a melody (blocking)
 *
 * Plays a sequence of tones. Blocks until complete.
 * Should only be called from AudioTask or during initialization.
 *
 * @param melody Pointer to melody structure
 * @param volume Volume level 0-100
 */
void audioPlayMelody(const Melody* melody, uint8_t volume);

/**
 * @brief Play an audio event melody (blocking)
 *
 * Looks up and plays the melody for the given event type.
 * Should only be called from AudioTask.
 *
 * @param event Audio event type
 * @param volume Volume level 0-100
 */
void audioPlayEvent(AudioEventType event, uint8_t volume);

/**
 * @brief Stop any currently playing audio
 *
 * Immediately silences the buzzer.
 */
void audioStop(void);

/**
 * @brief Set the master audio enable state
 *
 * When disabled, all audio playback is suppressed.
 *
 * @param enabled true to enable audio, false to disable
 */
void audioSetEnabled(bool enabled);

/**
 * @brief Check if audio is enabled
 *
 * @return true if audio is enabled
 */
bool audioIsEnabled(void);

/**
 * @brief Toggle audio mute state
 *
 * Toggles between muted and unmuted. When toggling to unmuted,
 * plays a brief confirmation tone. When toggling to muted,
 * stops any playing audio immediately.
 *
 * This is designed to be called from a button press handler.
 *
 * @return true if audio is now enabled (unmuted), false if muted
 */
bool audioToggleMute(void);

/**
 * @brief Set the master volume level
 *
 * @param volume Volume level 0-100
 */
void audioSetVolume(uint8_t volume);

/**
 * @brief Get the current volume level
 *
 * @return Current volume level 0-100
 */
uint8_t audioGetVolume(void);

/**
 * @brief Set alerts-only mode
 *
 * When enabled, only alert sounds play (not status sounds).
 *
 * @param alertsOnly true to only play alerts
 */
void audioSetAlertsOnly(bool alertsOnly);

/**
 * @brief Check if alerts-only mode is active
 *
 * @return true if only alerts will play
 */
bool audioIsAlertsOnly(void);

// =============================================================================
// Queue-Based Interface (for use from other tasks)
// =============================================================================

/**
 * @brief Queue an audio event for playback (non-blocking)
 *
 * Safe to call from any task. The event will be played
 * by AudioTask when it processes the queue.
 *
 * @param event Audio event type to play
 * @return true if queued successfully, false if queue full or disabled
 */
bool audioQueueEvent(AudioEventType event);

/**
 * @brief Queue a custom tone for playback (non-blocking)
 *
 * @param frequency Tone frequency in Hz
 * @param durationMs Duration in milliseconds
 * @return true if queued successfully
 */
bool audioQueueTone(uint16_t frequency, uint16_t durationMs);

/**
 * @brief Start locate mode (repeating beacon)
 *
 * Queues locate start event. AudioTask will repeatedly
 * play the locate beep until duration expires or stopped.
 *
 * @param durationSec Duration of locate mode in seconds
 * @return true if queued successfully
 */
bool audioStartLocate(uint16_t durationSec);

/**
 * @brief Stop locate mode
 *
 * @return true if stop command queued
 */
bool audioStopLocate(void);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * @brief Check if an event type is an alert
 *
 * Used to filter events when alerts-only mode is active.
 *
 * @param event Audio event type
 * @return true if this is an alert event
 */
bool audioIsAlertEvent(AudioEventType event);

/**
 * @brief Get melody name for an event (for logging/debug)
 *
 * @param event Audio event type
 * @return String name of the melody
 */
const char* audioGetEventName(AudioEventType event);

#endif // SONGBIRD_AUDIO_H
