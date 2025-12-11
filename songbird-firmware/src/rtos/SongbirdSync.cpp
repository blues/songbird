/**
 * @file SongbirdSync.cpp
 * @brief FreeRTOS synchronization primitives implementation
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdSync.h"

// =============================================================================
// Global Synchronization Primitive Handles
// =============================================================================

SemaphoreHandle_t g_i2cMutex = NULL;
SemaphoreHandle_t g_configMutex = NULL;
QueueHandle_t g_audioQueue = NULL;
QueueHandle_t g_noteQueue = NULL;
QueueHandle_t g_configQueue = NULL;
SemaphoreHandle_t g_syncSemaphore = NULL;
EventGroupHandle_t g_sleepEvent = NULL;

// =============================================================================
// Global Flags
// =============================================================================

volatile bool g_sleepRequested = false;
volatile bool g_systemReady = false;

// =============================================================================
// Initialization
// =============================================================================

bool syncInit(void) {
    // Create mutexes
    g_i2cMutex = xSemaphoreCreateMutex();
    if (g_i2cMutex == NULL) {
        return false;
    }

    g_configMutex = xSemaphoreCreateMutex();
    if (g_configMutex == NULL) {
        return false;
    }

    // Create queues
    g_audioQueue = xQueueCreate(AUDIO_QUEUE_SIZE, sizeof(AudioQueueItem));
    if (g_audioQueue == NULL) {
        return false;
    }

    g_noteQueue = xQueueCreate(NOTE_QUEUE_SIZE, sizeof(NoteQueueItem));
    if (g_noteQueue == NULL) {
        return false;
    }

    g_configQueue = xQueueCreate(CONFIG_QUEUE_SIZE, sizeof(SongbirdConfig));
    if (g_configQueue == NULL) {
        return false;
    }

    // Create binary semaphore for sync signaling
    g_syncSemaphore = xSemaphoreCreateBinary();
    if (g_syncSemaphore == NULL) {
        return false;
    }

    // Create event group for sleep coordination
    g_sleepEvent = xEventGroupCreate();
    if (g_sleepEvent == NULL) {
        return false;
    }

    // Register queues for debugging (optional, but helpful)
    #if configQUEUE_REGISTRY_SIZE > 0
    vQueueAddToRegistry(g_audioQueue, "AudioQ");
    vQueueAddToRegistry(g_noteQueue, "NoteQ");
    vQueueAddToRegistry(g_configQueue, "ConfigQ");
    #endif

    return true;
}

// =============================================================================
// I2C Mutex
// =============================================================================

bool syncAcquireI2C(uint32_t timeoutMs) {
    if (g_i2cMutex == NULL) {
        return false;
    }
    return xSemaphoreTake(g_i2cMutex, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

void syncReleaseI2C(void) {
    if (g_i2cMutex != NULL) {
        xSemaphoreGive(g_i2cMutex);
    }
}

// =============================================================================
// Config Mutex
// =============================================================================

bool syncAcquireConfig(uint32_t timeoutMs) {
    if (g_configMutex == NULL) {
        return false;
    }
    return xSemaphoreTake(g_configMutex, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

void syncReleaseConfig(void) {
    if (g_configMutex != NULL) {
        xSemaphoreGive(g_configMutex);
    }
}

// =============================================================================
// Audio Queue
// =============================================================================

bool syncQueueAudio(AudioEventType event) {
    AudioQueueItem item;
    memset(&item, 0, sizeof(item));
    item.event = event;
    return syncQueueAudioItem(&item);
}

bool syncQueueAudioItem(const AudioQueueItem* item) {
    if (g_audioQueue == NULL || item == NULL) {
        return false;
    }
    // Non-blocking send - don't wait if queue is full
    return xQueueSend(g_audioQueue, item, 0) == pdTRUE;
}

bool syncReceiveAudio(AudioQueueItem* item, uint32_t timeoutMs) {
    if (g_audioQueue == NULL || item == NULL) {
        return false;
    }
    TickType_t ticks = (timeoutMs == portMAX_DELAY) ? portMAX_DELAY : pdMS_TO_TICKS(timeoutMs);
    return xQueueReceive(g_audioQueue, item, ticks) == pdTRUE;
}

// =============================================================================
// Note Queue
// =============================================================================

bool syncQueueNote(const NoteQueueItem* item) {
    if (g_noteQueue == NULL || item == NULL) {
        return false;
    }
    // Non-blocking send
    return xQueueSend(g_noteQueue, item, 0) == pdTRUE;
}

bool syncReceiveNote(NoteQueueItem* item, uint32_t timeoutMs) {
    if (g_noteQueue == NULL || item == NULL) {
        return false;
    }
    return xQueueReceive(g_noteQueue, item, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

// =============================================================================
// Config Queue
// =============================================================================

bool syncQueueConfig(const SongbirdConfig* config) {
    if (g_configQueue == NULL || config == NULL) {
        return false;
    }
    // Blocking send - config updates are important
    return xQueueSend(g_configQueue, config, portMAX_DELAY) == pdTRUE;
}

bool syncReceiveConfig(SongbirdConfig* config) {
    if (g_configQueue == NULL || config == NULL) {
        return false;
    }
    // Non-blocking receive - check if config available
    return xQueueReceive(g_configQueue, config, 0) == pdTRUE;
}

// =============================================================================
// Sync Semaphore
// =============================================================================

void syncSignalComplete(void) {
    if (g_syncSemaphore != NULL) {
        xSemaphoreGive(g_syncSemaphore);
    }
}

bool syncWaitComplete(uint32_t timeoutMs) {
    if (g_syncSemaphore == NULL) {
        return false;
    }
    return xSemaphoreTake(g_syncSemaphore, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
}

// =============================================================================
// Sleep Event Group
// =============================================================================

void syncSetSleepReady(EventBits_t bit) {
    if (g_sleepEvent != NULL) {
        xEventGroupSetBits(g_sleepEvent, bit);
    }
}

bool syncWaitAllSleepReady(uint32_t timeoutMs) {
    if (g_sleepEvent == NULL) {
        return false;
    }

    EventBits_t bits = xEventGroupWaitBits(
        g_sleepEvent,
        SLEEP_BITS_ALL,
        pdTRUE,     // Clear bits on exit
        pdTRUE,     // Wait for ALL bits
        pdMS_TO_TICKS(timeoutMs)
    );

    return (bits & SLEEP_BITS_ALL) == SLEEP_BITS_ALL;
}

void syncClearSleepBits(void) {
    if (g_sleepEvent != NULL) {
        xEventGroupClearBits(g_sleepEvent, SLEEP_BITS_ALL);
    }
}

// =============================================================================
// Debug Helpers (only in debug builds)
// =============================================================================

#ifdef DEBUG_MODE

void vAssertCalled(const char* file, int line) {
    // Disable interrupts
    taskDISABLE_INTERRUPTS();

    // Print assertion info
    Serial.print("ASSERT FAILED: ");
    Serial.print(file);
    Serial.print(":");
    Serial.println(line);
    Serial.flush();

    // Hang for debugging
    for (;;) {
        // Toggle LED to indicate assertion failure
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
        for (volatile int i = 0; i < 1000000; i++);
    }
}

#endif

// =============================================================================
// FreeRTOS Hook Functions
// =============================================================================

extern "C" {

// Called when malloc fails
void vApplicationMallocFailedHook(void) {
    #ifdef DEBUG_MODE
    Serial.println("ERROR: FreeRTOS malloc failed!");
    Serial.flush();
    #endif

    // Hang - this is a fatal error
    taskDISABLE_INTERRUPTS();
    for (;;);
}

// Called on stack overflow
void vApplicationStackOverflowHook(TaskHandle_t xTask, char* pcTaskName) {
    #ifdef DEBUG_MODE
    Serial.print("ERROR: Stack overflow in task: ");
    Serial.println(pcTaskName);
    Serial.flush();
    #endif

    // Hang - this is a fatal error
    taskDISABLE_INTERRUPTS();
    for (;;);
}

} // extern "C"
