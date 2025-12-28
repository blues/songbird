/**
 * @file SongbirdTasks.cpp
 * @brief FreeRTOS task implementations
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdTasks.h"
#include "SongbirdSync.h"
#include "SongbirdConfig.h"
#include "SongbirdAudio.h"
#include "SongbirdSensors.h"
#include "SongbirdNotecard.h"
#include "SongbirdEnv.h"
#include "SongbirdCommands.h"
#include "SongbirdState.h"

// =============================================================================
// Task Handles
// =============================================================================

TaskHandle_t g_mainTaskHandle = NULL;
TaskHandle_t g_sensorTaskHandle = NULL;
TaskHandle_t g_audioTaskHandle = NULL;
TaskHandle_t g_commandTaskHandle = NULL;
TaskHandle_t g_notecardTaskHandle = NULL;
TaskHandle_t g_envTaskHandle = NULL;

// =============================================================================
// Shared Configuration (protected by g_configMutex)
// =============================================================================

static SongbirdConfig s_currentConfig;

// =============================================================================
// Button State (for mute toggle, transit lock, and demo lock)
// =============================================================================

static bool s_lastButtonState = HIGH;       // Button is active-low with pull-up
static uint32_t s_lastButtonChange = 0;     // Debounce timing
static const uint32_t BUTTON_DEBOUNCE_MS = 50;

// Multi-click detection: 1=mute, 2=transit lock, 3=demo lock
static uint8_t s_clickCount = 0;            // Number of clicks in current window
static uint32_t s_firstClickTime = 0;       // Time of first click
static const uint32_t MULTI_CLICK_WINDOW_MS = 600;   // Window between clicks
static const uint32_t SINGLE_CLICK_DELAY_MS = 700;   // Delay before single-click action
static const uint32_t TRIPLE_CLICK_TIMEOUT_MS = 1000; // Total window for triple-click

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * @brief Queue an immediate track.qo note with current sensor readings
 *
 * Called when mode changes to immediately report the new mode along with
 * all current sensor readings. Must be called while holding I2C mutex.
 *
 * @param mode The new operating mode to report
 */
static void queueImmediateTrackNote(OperatingMode mode) {
    SensorData data;
    memset(&data, 0, sizeof(data));

    // Read current sensor values
    if (sensorsRead(&data)) {
        // Add battery voltage (ignore USB power status for now)
        bool usbPowered = false;
        data.voltage = notecardGetVoltage(&usbPowered);

        // Add motion status
        data.motion = notecardGetMotion();

        // Mark data as valid
        data.valid = true;
        data.timestamp = (uint32_t)time(NULL);

        // Queue the track note with forced sync for immediate delivery
        NoteQueueItem noteItem;
        noteItem.type = NOTE_TYPE_TRACK;
        noteItem.forceSync = true;  // Mode changes should sync immediately
        memcpy(&noteItem.data.track, &data, sizeof(SensorData));
        syncQueueNote(&noteItem);

        #ifdef DEBUG_MODE
        DEBUG_SERIAL.print("[MainTask] Queued immediate track.qo for mode change to: ");
        DEBUG_SERIAL.println(envGetModeName(mode));
        #endif
    } else {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[MainTask] Failed to read sensors for immediate track note");
        #endif
    }
}

// =============================================================================
// Task Creation
// =============================================================================

bool tasksCreate(void) {
    BaseType_t result;

    // Create MainTask
    result = xTaskCreate(
        MainTask,
        "Main",
        STACK_MAIN,
        NULL,
        PRIORITY_MAIN,
        &g_mainTaskHandle
    );
    if (result != pdPASS) return false;

    // Create SensorTask
    result = xTaskCreate(
        SensorTask,
        "Sensor",
        STACK_SENSOR,
        NULL,
        PRIORITY_SENSOR,
        &g_sensorTaskHandle
    );
    if (result != pdPASS) return false;

    // Create AudioTask
    result = xTaskCreate(
        AudioTask,
        "Audio",
        STACK_AUDIO,
        NULL,
        PRIORITY_AUDIO,
        &g_audioTaskHandle
    );
    if (result != pdPASS) return false;

    // Create CommandTask
    result = xTaskCreate(
        CommandTask,
        "Command",
        STACK_COMMAND,
        NULL,
        PRIORITY_COMMAND,
        &g_commandTaskHandle
    );
    if (result != pdPASS) return false;

    // Create NotecardTask
    result = xTaskCreate(
        NotecardTask,
        "Notecard",
        STACK_NOTECARD,
        NULL,
        PRIORITY_NOTECARD,
        &g_notecardTaskHandle
    );
    if (result != pdPASS) return false;

    // Create EnvTask
    result = xTaskCreate(
        EnvTask,
        "Env",
        STACK_ENV,
        NULL,
        PRIORITY_ENV,
        &g_envTaskHandle
    );
    if (result != pdPASS) return false;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Tasks] All tasks created");
    #endif

    return true;
}

void tasksStart(void) {
    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Tasks] Starting scheduler...");
    #endif

    vTaskStartScheduler();

    // Should never reach here
    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Tasks] ERROR: Scheduler returned!");
    #endif
}

// =============================================================================
// Task Utilities
// =============================================================================

bool tasksSleepRequested(void) {
    return g_sleepRequested;
}

void tasksGetConfig(SongbirdConfig* config) {
    if (config == NULL) return;

    if (syncAcquireConfig(100)) {
        memcpy(config, &s_currentConfig, sizeof(SongbirdConfig));
        syncReleaseConfig();
    }
}

void tasksLogStackUsage(void) {
    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Tasks] Stack high water marks:");
    DEBUG_SERIAL.print("  Main: ");
    DEBUG_SERIAL.println(uxTaskGetStackHighWaterMark(g_mainTaskHandle));
    DEBUG_SERIAL.print("  Sensor: ");
    DEBUG_SERIAL.println(uxTaskGetStackHighWaterMark(g_sensorTaskHandle));
    DEBUG_SERIAL.print("  Audio: ");
    DEBUG_SERIAL.println(uxTaskGetStackHighWaterMark(g_audioTaskHandle));
    DEBUG_SERIAL.print("  Command: ");
    DEBUG_SERIAL.println(uxTaskGetStackHighWaterMark(g_commandTaskHandle));
    DEBUG_SERIAL.print("  Notecard: ");
    DEBUG_SERIAL.println(uxTaskGetStackHighWaterMark(g_notecardTaskHandle));
    DEBUG_SERIAL.print("  Env: ");
    DEBUG_SERIAL.println(uxTaskGetStackHighWaterMark(g_envTaskHandle));
    #endif
}

// =============================================================================
// MainTask Implementation
// =============================================================================

void MainTask(void* pvParameters) {
    (void)pvParameters;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[MainTask] Starting");
    #endif

    // Initialize default configuration
    envInitDefaults(&s_currentConfig);

    // Play power-on melody directly (not queued) to avoid mutex contention
    // during startup when we hold I2C for extended Notecard operations
    audioPlayEvent(AUDIO_EVENT_POWER_ON, s_currentConfig.audioVolume);

    // Try to restore state from previous sleep
    bool warmBoot = false;
    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
        warmBoot = stateRestore();
        syncReleaseI2C();
    }

    if (!warmBoot) {
        // Cold boot - initialize state
        stateInit();

        // Configure Notecard (only on cold boot)
        // Note: GPS and tracking are configured inside notecardConfigure()
        if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
            notecardConfigure(s_currentConfig.mode);
            notecardSetupTemplates();
            syncReleaseI2C();
        }
    } else {
        // Warm boot - restore mode from state
        s_currentConfig.mode = stateGet()->currentMode;
    }

    // Wait for Notehub connection
    bool connected = false;
    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
        connected = notecardWaitConnection(NOTEHUB_CONNECT_TIMEOUT_MS);
        syncReleaseI2C();
    }

    if (connected) {
        // Play connected melody directly (not queued) to avoid mutex contention
        audioPlayEvent(AUDIO_EVENT_CONNECTED, s_currentConfig.audioVolume);
    }

    // Fetch initial configuration from environment variables
    OperatingMode initialMode = s_currentConfig.mode;
    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
        SongbirdConfig newConfig;
        envInitDefaults(&newConfig);
        if (envFetchConfig(&newConfig)) {
            if (syncAcquireConfig(100)) {
                memcpy(&s_currentConfig, &newConfig, sizeof(SongbirdConfig));
                syncReleaseConfig();
            }
        }

        // If mode changed from default after fetching env vars, reconfigure Notecard
        // This ensures GPS/tracking settings match the actual mode from env vars
        if (s_currentConfig.mode != initialMode) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.print("[MainTask] Mode changed from env vars: ");
            DEBUG_SERIAL.print(envGetModeName(initialMode));
            DEBUG_SERIAL.print(" -> ");
            DEBUG_SERIAL.println(envGetModeName(s_currentConfig.mode));
            #endif
            stateSetMode(s_currentConfig.mode);
            notecardConfigure(s_currentConfig.mode);
        }

        syncReleaseI2C();
    }

    // Signal system ready
    g_systemReady = true;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[MainTask] Initialization complete");
    envLogConfig(&s_currentConfig);
    #endif

    // Main loop
    for (;;) {
        // Check for configuration updates from EnvTask
        SongbirdConfig newConfig;
        if (syncReceiveConfig(&newConfig)) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.println("[MainTask] Config update received");
            #endif

            // Apply new configuration
            if (syncAcquireConfig(100)) {
                OperatingMode oldMode = s_currentConfig.mode;
                memcpy(&s_currentConfig, &newConfig, sizeof(SongbirdConfig));
                syncReleaseConfig();

                // If mode changed, reconfigure Notecard and send immediate track note
                // Note: GPS and tracking are configured inside notecardConfigure()
                if (oldMode != newConfig.mode) {
                    stateSetMode(newConfig.mode);
                    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                        notecardConfigure(newConfig.mode);
                        // Queue immediate track.qo with new mode and current readings
                        queueImmediateTrackNote(newConfig.mode);
                        syncReleaseI2C();
                    }
                }

                // Update audio settings
                audioSetEnabled(newConfig.audioEnabled);
                audioSetVolume(newConfig.audioVolume);
                audioSetAlertsOnly(newConfig.audioAlertsOnly);
            }
        }

        // Check if we should enter deep sleep
        // (In a real implementation, this would be more sophisticated)
        // For now, we don't automatically sleep - let the device run continuously

        // Handle user button: 1-click=mute, 2-click=transit lock, 3-click=demo lock
        bool currentButtonState = digitalRead(BUTTON_PIN);
        uint32_t now = millis();

        // Handle button state change with debounce
        if (currentButtonState != s_lastButtonState) {
            if (now - s_lastButtonChange > BUTTON_DEBOUNCE_MS) {
                s_lastButtonChange = now;
                s_lastButtonState = currentButtonState;

                // Button pressed (active low)
                if (currentButtonState == LOW) {
                    s_clickCount++;
                    if (s_clickCount == 1) {
                        s_firstClickTime = now;
                    }

                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.print("[MainTask] Click count: ");
                    DEBUG_SERIAL.println(s_clickCount);
                    #endif
                }
            }
        }

        // Process click actions after timing window
        if (s_clickCount > 0) {
            uint32_t elapsed = now - s_firstClickTime;

            // Check for triple-click (mute toggle) - must check first
            if (s_clickCount >= 3 && elapsed < TRIPLE_CLICK_TIMEOUT_MS) {
                // Triple-click detected - toggle mute
                #ifdef DEBUG_MODE
                DEBUG_SERIAL.println("[MainTask] Triple-click - toggling mute");
                #endif
                audioToggleMute();
                s_clickCount = 0;
            }
            // Check for double-click (demo lock) - after triple-click window
            else if (s_clickCount == 2 && elapsed >= MULTI_CLICK_WINDOW_MS && elapsed < TRIPLE_CLICK_TIMEOUT_MS) {
                // Double-click detected - toggle demo lock
                #ifdef DEBUG_MODE
                DEBUG_SERIAL.println("[MainTask] Double-click - toggling demo lock");
                #endif

                // Guard: reject if transit lock is active (can't enable demo lock while transit locked)
                if (stateIsTransitLocked() && !stateIsDemoLocked()) {
                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.println("[MainTask] Demo lock rejected - transit lock is active");
                    #endif
                    audioQueueEvent(AUDIO_EVENT_ERROR);
                    s_clickCount = 0;
                }
                else if (stateIsDemoLocked()) {
                    // Unlock: restore previous mode
                    OperatingMode previousMode = stateGetPreDemoMode();
                    stateSetDemoLock(false, MODE_DEMO);
                    stateSetMode(previousMode);

                    // Apply the restored mode
                    if (syncAcquireConfig(100)) {
                        s_currentConfig.mode = previousMode;
                        syncReleaseConfig();
                    }
                    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                        notecardConfigure(previousMode);
                        queueImmediateTrackNote(previousMode);
                        syncReleaseI2C();
                    }

                    audioQueueEvent(AUDIO_EVENT_DEMO_LOCK_OFF);

                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.print("[MainTask] Demo lock OFF, restored mode: ");
                    DEBUG_SERIAL.println(envGetModeName(previousMode));
                    #endif
                } else {
                    // Lock: save current mode and switch to demo
                    OperatingMode currentMode = s_currentConfig.mode;
                    stateSetDemoLock(true, currentMode);
                    stateSetMode(MODE_DEMO);

                    // Apply demo mode
                    if (syncAcquireConfig(100)) {
                        s_currentConfig.mode = MODE_DEMO;
                        syncReleaseConfig();
                    }
                    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                        notecardConfigure(MODE_DEMO);
                        queueImmediateTrackNote(MODE_DEMO);
                        syncReleaseI2C();
                    }

                    audioQueueEvent(AUDIO_EVENT_DEMO_LOCK_ON);

                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.print("[MainTask] Demo lock ON, saved mode: ");
                    DEBUG_SERIAL.println(envGetModeName(currentMode));
                    #endif
                }

                s_clickCount = 0;
            }
            // Single click: wait for full timeout to ensure no more clicks coming
            else if (s_clickCount == 1 && elapsed >= TRIPLE_CLICK_TIMEOUT_MS) {
                // Single click - toggle transit lock
                #ifdef DEBUG_MODE
                DEBUG_SERIAL.println("[MainTask] Single-click - toggling transit lock");
                #endif

                // Guard: reject if demo lock is active (can't enable transit lock while demo locked)
                if (stateIsDemoLocked() && !stateIsTransitLocked()) {
                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.println("[MainTask] Transit lock rejected - demo lock is active");
                    #endif
                    audioQueueEvent(AUDIO_EVENT_ERROR);
                }
                else if (stateIsTransitLocked()) {
                    // Unlock: restore previous mode
                    OperatingMode previousMode = stateGetPreTransitMode();
                    stateSetTransitLock(false, MODE_DEMO);
                    stateSetMode(previousMode);

                    // Apply the restored mode
                    if (syncAcquireConfig(100)) {
                        s_currentConfig.mode = previousMode;
                        syncReleaseConfig();
                    }
                    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                        notecardConfigure(previousMode);
                        queueImmediateTrackNote(previousMode);
                        syncReleaseI2C();
                    }

                    audioQueueEvent(AUDIO_EVENT_TRANSIT_LOCK_OFF);

                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.print("[MainTask] Transit lock OFF, restored mode: ");
                    DEBUG_SERIAL.println(envGetModeName(previousMode));
                    #endif
                } else {
                    // Lock: save current mode and switch to transit
                    OperatingMode currentMode = s_currentConfig.mode;
                    stateSetTransitLock(true, currentMode);
                    stateSetMode(MODE_TRANSIT);

                    // Apply transit mode
                    if (syncAcquireConfig(100)) {
                        s_currentConfig.mode = MODE_TRANSIT;
                        syncReleaseConfig();
                    }
                    if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                        notecardConfigure(MODE_TRANSIT);
                        queueImmediateTrackNote(MODE_TRANSIT);
                        syncReleaseI2C();
                    }

                    audioQueueEvent(AUDIO_EVENT_TRANSIT_LOCK_ON);

                    #ifdef DEBUG_MODE
                    DEBUG_SERIAL.print("[MainTask] Transit lock ON, saved mode: ");
                    DEBUG_SERIAL.println(envGetModeName(currentMode));
                    #endif
                }

                s_clickCount = 0;
            }
            // Timeout with unexpected click count (safety reset)
            else if (elapsed >= TRIPLE_CLICK_TIMEOUT_MS) {
                s_clickCount = 0;
            }
        }

        // Periodic health check
        static uint32_t lastHealthCheck = 0;
        if (millis() - lastHealthCheck > 60000) {  // Every minute
            lastHealthCheck = millis();

            #ifdef DEBUG_MODE
            tasksLogStackUsage();
            #endif
        }

        // Check for sleep request
        if (g_sleepRequested) {
            // Coordinate sleep with all tasks
            syncSetSleepReady(SLEEP_BIT_SENSOR);  // MainTask doesn't have its own bit

            if (syncWaitAllSleepReady(SLEEP_COORDINATION_TIMEOUT_MS)) {
                // All tasks ready - enter sleep
                audioPlayEvent(AUDIO_EVENT_SLEEP, s_currentConfig.audioVolume);

                if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                    stateSave();
                    notecardEnterSleep();
                    // Should not return
                    syncReleaseI2C();
                }
            }

            // Sleep failed or timed out
            g_sleepRequested = false;
            syncClearSleepBits();
        }

        vTaskDelay(pdMS_TO_TICKS(MAIN_LOOP_INTERVAL_MS));
    }
}

// =============================================================================
// SensorTask Implementation
// =============================================================================

void SensorTask(void* pvParameters) {
    (void)pvParameters;

    // Wait for system ready
    while (!g_systemReady) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[SensorTask] Starting");
    #endif

    // Note: Sensors are now initialized in main.cpp setup() for reliability
    // at low battery voltage. If init failed there, try again here.
    if (!sensorsIsAvailable()) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[SensorTask] Sensors not available, attempting init...");
        #endif
        if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
            sensorsInit();
            syncReleaseI2C();
        }
    }

    TickType_t lastWakeTime = xTaskGetTickCount();
    SensorData data;

    // Track USB power state to detect changes
    // Start with "unknown" state (-1) to force initial configuration
    static int8_t s_lastUsbPowered = -1;

    for (;;) {
        // Check for sleep request
        if (g_sleepRequested) {
            syncSetSleepReady(SLEEP_BIT_SENSOR);
            vTaskSuspend(NULL);
            continue;
        }

        // Get current config
        SongbirdConfig config;
        tasksGetConfig(&config);

        // Read sensors
        bool readSuccess = false;
        if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
            readSuccess = sensorsRead(&data);

            // Get battery voltage and USB power status
            bool usbPowered = false;
            data.voltage = notecardGetVoltage(&usbPowered);

            // Check for USB power state change and toggle Mojo monitoring
            int8_t currentUsbState = usbPowered ? 1 : 0;
            if (currentUsbState != s_lastUsbPowered) {
                #ifdef DEBUG_MODE
                DEBUG_SERIAL.print("[SensorTask] USB power state changed: ");
                DEBUG_SERIAL.println(usbPowered ? "USB powered" : "battery powered");
                #endif

                // Enable Mojo when on battery, disable when on USB
                notecardConfigureMojo(!usbPowered, config.mode);
                s_lastUsbPowered = currentUsbState;
            }

            // Get motion status
            data.motion = notecardGetMotion() || stateGetAndClearMotion();

            syncReleaseI2C();
        }

        if (readSuccess) {
            // Check for alerts
            uint8_t currentAlerts = stateGetAlerts();
            uint8_t newAlerts = sensorsCheckAlerts(&data, &config,
                                                    stateGetLastPressure(),
                                                    currentAlerts);

            // Process new alerts
            if (newAlerts != 0) {
                for (uint8_t flag = 1; flag != 0; flag <<= 1) {
                    if (newAlerts & flag) {
                        // Build alert
                        Alert alert;
                        sensorsBuildAlert(flag, &data, &config, &alert);

                        // Queue alert note
                        NoteQueueItem noteItem;
                        noteItem.type = NOTE_TYPE_ALERT;
                        memcpy(&noteItem.data.alert, &alert, sizeof(Alert));
                        syncQueueNote(&noteItem);

                        // Queue audio
                        if (flag & (ALERT_FLAG_TEMP_HIGH | ALERT_FLAG_TEMP_LOW)) {
                            audioQueueEvent(AUDIO_EVENT_TEMP_ALERT);
                        } else if (flag & (ALERT_FLAG_HUMIDITY_HIGH | ALERT_FLAG_HUMIDITY_LOW)) {
                            audioQueueEvent(AUDIO_EVENT_HUMIDITY_ALERT);
                        } else if (flag & ALERT_FLAG_LOW_BATTERY) {
                            audioQueueEvent(AUDIO_EVENT_LOW_BATTERY);
                        }

                        // Mark alert as sent
                        stateSetAlert(flag);
                    }
                }
            }

            // Check for cleared alerts
            uint8_t clearedAlerts = sensorsCheckAlertsCleared(&data, &config, currentAlerts);
            for (uint8_t flag = 1; flag != 0; flag <<= 1) {
                if (clearedAlerts & flag) {
                    stateClearAlert(flag);
                }
            }

            // Update state
            stateUpdateLastPressure(data.pressure);
            if (data.motion) {
                stateSetMotion(true);
            }

            // Queue track note
            NoteQueueItem noteItem;
            noteItem.type = NOTE_TYPE_TRACK;
            noteItem.forceSync = false;  // Regular sensor readings use mode-based sync
            memcpy(&noteItem.data.track, &data, sizeof(SensorData));
            syncQueueNote(&noteItem);
        }

        // Wait for next interval
        uint32_t interval = envGetSensorIntervalMs(&config);
        if (interval > 0) {
            vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(interval));
        } else {
            // Sleep mode - just wait
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}

// =============================================================================
// AudioTask Implementation
// =============================================================================

void AudioTask(void* pvParameters) {
    (void)pvParameters;

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[AudioTask] Starting");
    #endif

    AudioQueueItem item;
    bool locateActive = false;
    TickType_t locateEndTime = 0;

    for (;;) {
        // Check for sleep request
        if (g_sleepRequested && !locateActive) {
            syncSetSleepReady(SLEEP_BIT_AUDIO);
            vTaskSuspend(NULL);
            continue;
        }

        // Determine wait time
        TickType_t waitTime = locateActive ? pdMS_TO_TICKS(50) : portMAX_DELAY;

        // Check for audio events
        if (syncReceiveAudio(&item, waitTime)) {
            switch (item.event) {
                case AUDIO_EVENT_LOCATE_STOP:
                    locateActive = false;
                    break;

                case AUDIO_EVENT_LOCATE_START:
                    locateActive = true;
                    locateEndTime = xTaskGetTickCount() +
                                    pdMS_TO_TICKS(item.locateDurationSec * 1000);
                    break;

                case AUDIO_EVENT_CUSTOM_TONE:
                    audioPlayTone(item.frequency, item.durationMs, audioGetVolume());
                    break;

                default:
                    audioPlayEvent(item.event, audioGetVolume());
                    break;
            }
        }

        // Handle locate mode
        if (locateActive) {
            if (xTaskGetTickCount() >= locateEndTime) {
                locateActive = false;
            } else {
                // Play locate beep
                audioPlayEvent(AUDIO_EVENT_LOCATE_START, audioGetVolume());
                vTaskDelay(pdMS_TO_TICKS(LOCATE_PAUSE_MS));
            }
        }
    }
}

// =============================================================================
// CommandTask Implementation
// =============================================================================

void CommandTask(void* pvParameters) {
    (void)pvParameters;

    // Wait for system ready
    while (!g_systemReady) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[CommandTask] Starting");
    #endif

    for (;;) {
        // Check for sleep request
        if (g_sleepRequested) {
            syncSetSleepReady(SLEEP_BIT_COMMAND);
            vTaskSuspend(NULL);
            continue;
        }

        // Get current config
        SongbirdConfig config;
        tasksGetConfig(&config);

        // Check for commands
        Command cmd;
        bool hasCommand = false;

        if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
            hasCommand = notecardGetCommand(&cmd);
            syncReleaseI2C();
        }

        if (hasCommand) {
            // Execute command
            CommandAck ack;
            commandsExecute(&cmd, &config, &ack);

            // Send acknowledgment if enabled
            if (config.cmdAckEnabled) {
                NoteQueueItem noteItem;
                noteItem.type = NOTE_TYPE_CMD_ACK;
                memcpy(&noteItem.data.ack, &ack, sizeof(CommandAck));
                syncQueueNote(&noteItem);
            }
        }

        // Wait for next poll
        uint32_t interval = envGetCommandPollIntervalMs(&config);
        if (interval > 0) {
            vTaskDelay(pdMS_TO_TICKS(interval));
        } else {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}

// =============================================================================
// NotecardTask Implementation
// =============================================================================

void NotecardTask(void* pvParameters) {
    (void)pvParameters;

    // Wait for system ready
    while (!g_systemReady) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[NotecardTask] Starting");
    #endif

    uint32_t lastSyncCheck = 0;
    NoteQueueItem item;

    for (;;) {
        // Check for sleep request
        if (g_sleepRequested) {
            syncSetSleepReady(SLEEP_BIT_NOTECARD);
            vTaskSuspend(NULL);
            continue;
        }

        // Get current config
        SongbirdConfig config;
        tasksGetConfig(&config);

        // Process note queue
        if (syncReceiveNote(&item, 100)) {
            if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                switch (item.type) {
                    case NOTE_TYPE_TRACK:
                        notecardSendTrackNote(&item.data.track, config.mode, item.forceSync);
                        break;

                    case NOTE_TYPE_ALERT:
                        notecardSendAlertNote(&item.data.alert);
                        break;

                    case NOTE_TYPE_CMD_ACK:
                        notecardSendCommandAck(&item.data.ack);
                        break;

                    case NOTE_TYPE_HEALTH:
                        notecardSendHealthNote(&item.data.health);
                        break;
                }
                syncReleaseI2C();
            }
        }

        // Periodic sync check
        if (millis() - lastSyncCheck > SYNC_CHECK_INTERVAL_MS) {
            lastSyncCheck = millis();

            if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                // Check GPS status
                bool hasLock;
                double lat, lon;
                uint32_t timeSec;
                if (notecardGetGPSStatus(&hasLock, &lat, &lon, &timeSec)) {
                    if (hasLock && timeSec < 10) {
                        // Fresh GPS fix
                        stateUpdateGpsFixTime();
                        audioQueueEvent(AUDIO_EVENT_GPS_LOCK);
                    }
                }

                // Check if we need to sync
                if (config.mode == MODE_DEMO) {
                    // Continuous sync in demo mode
                    if (!notecardIsSyncing()) {
                        notecardSync();
                    }
                }

                syncReleaseI2C();
            }
        }
    }
}

// =============================================================================
// EnvTask Implementation
// =============================================================================

void EnvTask(void* pvParameters) {
    (void)pvParameters;

    // Wait for system ready
    while (!g_systemReady) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[EnvTask] Starting");
    #endif

    SongbirdConfig lastConfig;
    tasksGetConfig(&lastConfig);

    for (;;) {
        // Check for sleep request
        if (g_sleepRequested) {
            syncSetSleepReady(SLEEP_BIT_ENV);
            vTaskSuspend(NULL);
            continue;
        }

        // Check if environment variables modified
        bool modified = false;
        if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
            modified = envCheckModified();
            syncReleaseI2C();
        }

        if (modified) {
            // Fetch new configuration
            SongbirdConfig newConfig;
            tasksGetConfig(&newConfig);  // Start with current

            if (syncAcquireI2C(I2C_MUTEX_TIMEOUT_MS)) {
                envFetchConfig(&newConfig);
                syncReleaseI2C();
            }

            // Check if config actually changed
            if (envConfigChanged(&lastConfig, &newConfig)) {
                // Log which specific values changed (always, for demo visibility)
                envLogConfigChanges(&lastConfig, &newConfig);

                // Send to MainTask
                syncQueueConfig(&newConfig);

                // Update our copy
                memcpy(&lastConfig, &newConfig, sizeof(SongbirdConfig));
            }
        }

        vTaskDelay(pdMS_TO_TICKS(ENV_POLL_INTERVAL_MS));
    }
}
