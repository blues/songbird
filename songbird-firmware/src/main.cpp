/**
 * @file main.cpp
 * @brief Main sketch for Songbird - Blues Sales Demo Device
 *
 * Songbird is a portable, battery-powered asset tracker and environmental
 * monitor designed as a sales demonstration tool for Blues.
 *
 * Features:
 * - BME280 environmental sensing (temp, humidity, pressure)
 * - GPS/GNSS location tracking via Notecard
 * - Audio feedback via piezo buzzer
 * - Remote configuration via Notehub environment variables
 * - Cloud-to-device command handling
 * - Low-power operation with ATTN-based sleep
 *
 * Hardware:
 * - Blues Cygnet (STM32L433)
 * - Notecarrier-F with ATTN→EN connection
 * - Notecard Cell+WiFi (NBGL)
 * - BME280 Qwiic breakout
 * - Passive piezo buzzer on PA8
 *
 * Architecture:
 * - FreeRTOS with 6 tasks
 * - Queue-based inter-task communication
 * - Mutex-protected I2C and configuration access
 *
 * Copyright (c) 2025 Blues Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <Arduino.h>
#include <Wire.h>
#include <STM32FreeRTOS.h>

// Songbird modules
#include "SongbirdConfig.h"
#include "SongbirdSync.h"
#include "SongbirdAudio.h"
#include "SongbirdSensors.h"
#include "SongbirdNotecard.h"
#include "SongbirdEnv.h"
#include "SongbirdCommands.h"
#include "SongbirdState.h"
#include "SongbirdTasks.h"

// =============================================================================
// Setup
// =============================================================================

void setup() {
    // Initialize serial for debugging
    Serial.begin(115200);

    // Wait for serial in debug mode (with timeout)
    #ifdef DEBUG_MODE
    uint32_t serialWait = millis();
    while (!Serial && (millis() - serialWait < 3000)) {
        delay(10);
    }
    #endif

    Serial.println();
    Serial.println("========================================");
    Serial.println("  Songbird - Blues Sales Demo Device");
    Serial.print("  Firmware: ");
    Serial.println(FIRMWARE_VERSION);
    Serial.print("  Product:  ");
    Serial.println(PRODUCT_UID);
    Serial.println("========================================");
    Serial.println();

    // Initialize GPIO
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);  // LED on during init

    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // Initialize I2C
    Wire.begin();
    Wire.setClock(400000);  // 400kHz I2C

    Serial.println("[Init] GPIO and I2C initialized");

    // Initialize audio system (before RTOS)
    audioInit();
    Serial.println("[Init] Audio initialized");

    // Initialize Notecard
    if (!notecardInit()) {
        Serial.println("[Init] ERROR: Notecard init failed!");
        // Play error tone
        audioPlayEvent(AUDIO_EVENT_ERROR, DEFAULT_AUDIO_VOLUME);
        // Continue anyway - might recover later
    } else {
        Serial.println("[Init] Notecard initialized");
    }

    // Initialize synchronization primitives
    if (!syncInit()) {
        Serial.println("[Init] ERROR: Sync init failed!");
        audioPlayEvent(AUDIO_EVENT_ERROR, DEFAULT_AUDIO_VOLUME);
        // This is fatal - can't continue without RTOS primitives
        while (1) {
            digitalWrite(LED_PIN, !digitalRead(LED_PIN));
            delay(100);
        }
    }
    Serial.println("[Init] Sync primitives initialized");

    // Create FreeRTOS tasks
    if (!tasksCreate()) {
        Serial.println("[Init] ERROR: Task creation failed!");
        audioPlayEvent(AUDIO_EVENT_ERROR, DEFAULT_AUDIO_VOLUME);
        while (1) {
            digitalWrite(LED_PIN, !digitalRead(LED_PIN));
            delay(100);
        }
    }
    Serial.println("[Init] Tasks created");

    // Turn off LED - tasks will control it
    digitalWrite(LED_PIN, LOW);

    Serial.println("[Init] Starting FreeRTOS scheduler...");
    Serial.println();

    // Start FreeRTOS scheduler
    // This function does not return
    tasksStart();

    // Should never reach here
    Serial.println("[Init] ERROR: Scheduler returned!");
    while (1) {
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
        delay(50);
    }
}

// =============================================================================
// Loop
// =============================================================================

// Not used with FreeRTOS - tasks handle everything
void loop() {
    // FreeRTOS scheduler is running - this should never execute
    vTaskDelay(portMAX_DELAY);
}

// =============================================================================
// Optional: Idle Hook (if enabled in FreeRTOSConfig)
// =============================================================================

#if configUSE_IDLE_HOOK == 1
extern "C" void vApplicationIdleHook(void) {
    // Called when idle task runs
    // Could be used for low-power optimizations
}
#endif

// =============================================================================
// Optional: Tick Hook (if enabled in FreeRTOSConfig)
// =============================================================================

#if configUSE_TICK_HOOK == 1
extern "C" void vApplicationTickHook(void) {
    // Called every tick
}
#endif
