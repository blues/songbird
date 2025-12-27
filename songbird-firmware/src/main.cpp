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

// =============================================================================
// Serial Configuration (STLink VCP)
// =============================================================================

HardwareSerial serialDebug(PIN_VCP_RX, PIN_VCP_TX);

#define SERIAL_BAUD 115200
#define DEBUG_SERIAL serialDebug
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
    // Initialize serial for debugging via STLink VCP
    DEBUG_SERIAL.begin(SERIAL_BAUD);

    // Wait for serial in debug mode (with timeout)
    #ifdef DEBUG_MODE
    uint32_t serialWait = millis();
    while (!DEBUG_SERIAL && (millis() - serialWait < 3000)) {
        delay(10);
    }
    #endif

    DEBUG_SERIAL.println();
    DEBUG_SERIAL.println("========================================");
    DEBUG_SERIAL.println("  Songbird - Blues Sales Demo Device");
    DEBUG_SERIAL.print("  Firmware: ");
    DEBUG_SERIAL.println(FIRMWARE_VERSION);
    DEBUG_SERIAL.print("  Product:  ");
    DEBUG_SERIAL.println(PRODUCT_UID);
    DEBUG_SERIAL.println("========================================");
    DEBUG_SERIAL.println();

    // Initialize GPIO
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);  // LED on during init

    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // Initialize I2C at standard speed for reliable startup
    // (Fast mode can be unreliable at lower battery voltages)
    Wire.begin();
    Wire.setClock(100000);  // 100kHz - more reliable at low voltage

    DEBUG_SERIAL.println("[Init] GPIO and I2C initialized (100kHz)");

    // Small delay to allow I2C peripherals to stabilize after power-on
    delay(50);

    // Initialize audio system with retry (before RTOS)
    if (!audioInit()) {
        DEBUG_SERIAL.println("[Init] Audio init failed, retrying...");
        delay(100);
        audioInit();  // Second attempt
    }
    DEBUG_SERIAL.println("[Init] Audio initialized");

    // Initialize sensors with retry (before RTOS)
    if (!sensorsInit()) {
        DEBUG_SERIAL.println("[Init] Sensors init failed, retrying...");
        delay(100);
        sensorsInit();  // Second attempt
    }
    DEBUG_SERIAL.println("[Init] Sensors initialized");

    // Switch to fast mode now that peripherals are initialized
    Wire.setClock(400000);  // 400kHz for normal operation
    DEBUG_SERIAL.println("[Init] I2C switched to 400kHz");

    // Initialize Notecard
    if (!notecardInit()) {
        DEBUG_SERIAL.println("[Init] ERROR: Notecard init failed!");
        // Play error tone
        audioPlayEvent(AUDIO_EVENT_ERROR, DEFAULT_AUDIO_VOLUME);
        // Continue anyway - might recover later
    } else {
        DEBUG_SERIAL.println("[Init] Notecard initialized");
    }

    // Initialize synchronization primitives
    if (!syncInit()) {
        DEBUG_SERIAL.println("[Init] ERROR: Sync init failed!");
        audioPlayEvent(AUDIO_EVENT_ERROR, DEFAULT_AUDIO_VOLUME);
        // This is fatal - can't continue without RTOS primitives
        while (1) {
            digitalWrite(LED_PIN, !digitalRead(LED_PIN));
            delay(100);
        }
    }
    DEBUG_SERIAL.println("[Init] Sync primitives initialized");

    // Create FreeRTOS tasks
    if (!tasksCreate()) {
        DEBUG_SERIAL.println("[Init] ERROR: Task creation failed!");
        audioPlayEvent(AUDIO_EVENT_ERROR, DEFAULT_AUDIO_VOLUME);
        while (1) {
            digitalWrite(LED_PIN, !digitalRead(LED_PIN));
            delay(100);
        }
    }
    DEBUG_SERIAL.println("[Init] Tasks created");

    // Turn off LED - tasks will control it
    digitalWrite(LED_PIN, LOW);

    DEBUG_SERIAL.println("[Init] Starting FreeRTOS scheduler...");
    DEBUG_SERIAL.println();

    // Start FreeRTOS scheduler
    // This function does not return
    tasksStart();

    // Should never reach here
    DEBUG_SERIAL.println("[Init] ERROR: Scheduler returned!");
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
