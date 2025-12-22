/**
 * @file SongbirdSync.h
 * @brief FreeRTOS synchronization primitives for Songbird
 *
 * Provides mutexes, queues, semaphores, and event groups for
 * inter-task communication and resource protection.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_SYNC_H
#define SONGBIRD_SYNC_H

#include <Arduino.h>
#include <STM32FreeRTOS.h>
#include <semphr.h>
#include <queue.h>
#include <event_groups.h>

#include "SongbirdConfig.h"

// =============================================================================
// Forward Declarations for Queue Item Types
// =============================================================================

// Audio event type (full definition in SongbirdAudio.h)
typedef enum {
    AUDIO_EVENT_POWER_ON = 0,
    AUDIO_EVENT_CONNECTED,
    AUDIO_EVENT_GPS_LOCK,
    AUDIO_EVENT_NOTE_SENT,
    AUDIO_EVENT_MOTION,
    AUDIO_EVENT_TEMP_ALERT,
    AUDIO_EVENT_HUMIDITY_ALERT,
    AUDIO_EVENT_LOW_BATTERY,
    AUDIO_EVENT_BUTTON,
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

// Audio queue item
typedef struct {
    AudioEventType event;
    uint16_t frequency;         // For custom tone
    uint16_t durationMs;        // For custom tone
    uint16_t locateDurationSec; // For locate mode
} AudioQueueItem;

// Note type for outbound queue
typedef enum {
    NOTE_TYPE_TRACK = 0,
    NOTE_TYPE_ALERT,
    NOTE_TYPE_CMD_ACK,
    NOTE_TYPE_HEALTH
} NoteType;

// Note queue item
typedef struct {
    NoteType type;
    union {
        SensorData track;
        Alert alert;
        CommandAck ack;
        HealthData health;
    } data;
} NoteQueueItem;

// =============================================================================
// Synchronization Primitive Handles (extern declarations)
// =============================================================================

// Mutexes
extern SemaphoreHandle_t g_i2cMutex;        // Protects I2C bus (Notecard + BME280)
extern SemaphoreHandle_t g_configMutex;     // Protects shared configuration

// Queues
extern QueueHandle_t g_audioQueue;          // Audio events -> AudioTask
extern QueueHandle_t g_noteQueue;           // Outbound notes -> NotecardTask
extern QueueHandle_t g_configQueue;         // Config updates -> MainTask

// Semaphores
extern SemaphoreHandle_t g_syncSemaphore;   // Signals sync completion

// Event Groups
extern EventGroupHandle_t g_sleepEvent;     // Coordinates deep sleep

// =============================================================================
// Sleep Event Bits
// =============================================================================

#define SLEEP_BIT_SENSOR    (1 << 0)
#define SLEEP_BIT_AUDIO     (1 << 1)
#define SLEEP_BIT_COMMAND   (1 << 2)
#define SLEEP_BIT_ENV       (1 << 3)
#define SLEEP_BIT_NOTECARD  (1 << 4)
#define SLEEP_BITS_ALL      (SLEEP_BIT_SENSOR | SLEEP_BIT_AUDIO | SLEEP_BIT_COMMAND | SLEEP_BIT_ENV | SLEEP_BIT_NOTECARD)

// =============================================================================
// Global Flags
// =============================================================================

extern volatile bool g_sleepRequested;      // Set by MainTask to request sleep
extern volatile bool g_systemReady;         // Set when all tasks initialized

// =============================================================================
// Function Declarations
// =============================================================================

/**
 * @brief Initialize all synchronization primitives
 *
 * Must be called before creating any tasks. Creates:
 * - i2cMutex and configMutex
 * - audioQueue, noteQueue, and configQueue
 * - syncSemaphore
 * - sleepEvent group
 *
 * @return true if all primitives created successfully, false otherwise
 */
bool syncInit(void);

/**
 * @brief Acquire the I2C mutex with timeout
 *
 * @param timeoutMs Maximum time to wait for mutex (ms)
 * @return true if mutex acquired, false on timeout
 */
bool syncAcquireI2C(uint32_t timeoutMs);

/**
 * @brief Release the I2C mutex
 */
void syncReleaseI2C(void);

/**
 * @brief Acquire the config mutex with timeout
 *
 * @param timeoutMs Maximum time to wait for mutex (ms)
 * @return true if mutex acquired, false on timeout
 */
bool syncAcquireConfig(uint32_t timeoutMs);

/**
 * @brief Release the config mutex
 */
void syncReleaseConfig(void);

/**
 * @brief Queue an audio event (non-blocking)
 *
 * @param event Audio event type
 * @return true if queued successfully, false if queue full
 */
bool syncQueueAudio(AudioEventType event);

/**
 * @brief Queue an audio event with parameters (non-blocking)
 *
 * @param item Pointer to audio queue item
 * @return true if queued successfully, false if queue full
 */
bool syncQueueAudioItem(const AudioQueueItem* item);

/**
 * @brief Receive an audio event (blocking with timeout)
 *
 * @param item Pointer to receive audio queue item
 * @param timeoutMs Maximum time to wait (ms), use portMAX_DELAY for infinite
 * @return true if item received, false on timeout
 */
bool syncReceiveAudio(AudioQueueItem* item, uint32_t timeoutMs);

/**
 * @brief Queue an outbound note (non-blocking)
 *
 * @param item Pointer to note queue item
 * @return true if queued successfully, false if queue full
 */
bool syncQueueNote(const NoteQueueItem* item);

/**
 * @brief Receive an outbound note (blocking with timeout)
 *
 * @param item Pointer to receive note queue item
 * @param timeoutMs Maximum time to wait (ms)
 * @return true if item received, false on timeout
 */
bool syncReceiveNote(NoteQueueItem* item, uint32_t timeoutMs);

/**
 * @brief Queue a config update (blocking)
 *
 * @param config Pointer to new configuration
 * @return true if queued successfully
 */
bool syncQueueConfig(const SongbirdConfig* config);

/**
 * @brief Receive a config update (non-blocking)
 *
 * @param config Pointer to receive configuration
 * @return true if config received, false if queue empty
 */
bool syncReceiveConfig(SongbirdConfig* config);

/**
 * @brief Signal sync completion
 */
void syncSignalComplete(void);

/**
 * @brief Wait for sync completion
 *
 * @param timeoutMs Maximum time to wait (ms)
 * @return true if signaled, false on timeout
 */
bool syncWaitComplete(uint32_t timeoutMs);

/**
 * @brief Set a sleep ready bit for current task
 *
 * @param bit The SLEEP_BIT_* for this task
 */
void syncSetSleepReady(EventBits_t bit);

/**
 * @brief Wait for all tasks to be ready for sleep
 *
 * @param timeoutMs Maximum time to wait (ms)
 * @return true if all tasks ready, false on timeout
 */
bool syncWaitAllSleepReady(uint32_t timeoutMs);

/**
 * @brief Clear all sleep ready bits
 */
void syncClearSleepBits(void);

#endif // SONGBIRD_SYNC_H
