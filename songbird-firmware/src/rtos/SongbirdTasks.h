/**
 * @file SongbirdTasks.h
 * @brief FreeRTOS task declarations for Songbird
 *
 * Defines all task functions and their management interface.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_TASKS_H
#define SONGBIRD_TASKS_H

#include <Arduino.h>
#include <STM32FreeRTOS.h>
#include "SongbirdConfig.h"

// =============================================================================
// Task Handles (extern declarations)
// =============================================================================

extern TaskHandle_t g_mainTaskHandle;
extern TaskHandle_t g_sensorTaskHandle;
extern TaskHandle_t g_audioTaskHandle;
extern TaskHandle_t g_commandTaskHandle;
extern TaskHandle_t g_notecardTaskHandle;
extern TaskHandle_t g_envTaskHandle;

// =============================================================================
// Task Creation
// =============================================================================

/**
 * @brief Create all FreeRTOS tasks
 *
 * Creates all tasks but does not start the scheduler.
 * Call this after initializing sync primitives.
 *
 * @return true if all tasks created successfully
 */
bool tasksCreate(void);

/**
 * @brief Start the FreeRTOS scheduler
 *
 * This function does not return under normal operation.
 */
void tasksStart(void);

// =============================================================================
// Task Functions
// =============================================================================

/**
 * @brief Main orchestration task
 *
 * Responsibilities:
 * - Coordinate system startup
 * - Receive and distribute configuration updates
 * - Monitor system health
 * - Coordinate deep sleep
 *
 * Priority: Normal (2)
 * Stack: 512 words
 */
void MainTask(void* pvParameters);

/**
 * @brief Sensor reading task
 *
 * Responsibilities:
 * - Periodic BME280 sensor reads
 * - Alert threshold checking
 * - Queue track notes and alert notes
 * - Queue audio events for alerts
 *
 * Priority: Normal (2)
 * Stack: 512 words
 */
void SensorTask(void* pvParameters);

/**
 * @brief Audio playback task
 *
 * Responsibilities:
 * - Process audio event queue
 * - Play melodies and tones
 * - Handle locate mode (repeating beeps)
 * - Respect audio enable/volume settings
 *
 * Priority: Above Normal (3)
 * Stack: 256 words
 */
void AudioTask(void* pvParameters);

/**
 * @brief Command processing task
 *
 * Responsibilities:
 * - Poll command.qi for inbound commands
 * - Execute commands
 * - Queue command acknowledgments
 *
 * Priority: Above Normal (3)
 * Stack: 512 words
 */
void CommandTask(void* pvParameters);

/**
 * @brief Notecard communication task
 *
 * Responsibilities:
 * - Process outbound note queue
 * - Send notes to Notecard
 * - Handle sync operations
 * - GPS management
 *
 * Priority: High (4)
 * Stack: 1024 words
 */
void NotecardTask(void* pvParameters);

/**
 * @brief Environment variable task
 *
 * Responsibilities:
 * - Poll for environment variable changes
 * - Parse and validate new configuration
 * - Send config updates to MainTask
 *
 * Priority: Below Normal (1)
 * Stack: 512 words
 */
void EnvTask(void* pvParameters);

// =============================================================================
// Task Utilities
// =============================================================================

/**
 * @brief Check if all tasks should prepare for sleep
 *
 * @return true if sleep has been requested
 */
bool tasksSleepRequested(void);

/**
 * @brief Get current configuration (thread-safe)
 *
 * Copies current configuration to provided structure.
 *
 * @param config Pointer to config structure to fill
 */
void tasksGetConfig(SongbirdConfig* config);

/**
 * @brief Log task stack high water marks (debug)
 *
 * Prints stack usage for all tasks to DEBUG_SERIAL.
 */
void tasksLogStackUsage(void);

#endif // SONGBIRD_TASKS_H
