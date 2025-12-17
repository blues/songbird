# Songbird Firmware Implementation Plan

Based on the Songbird PRD v1.0

---

## Overview

This plan outlines the implementation of the Songbird firmware for the Blues Cygnet MCU using **FreeRTOS** for task management. The firmware manages environmental sensing (BME280), audio feedback (piezo buzzer), GPS tracking, cloud connectivity (Notecard), power management, and remote command handling.

The FreeRTOS architecture enables:
- **Non-blocking audio playback** - Melodies play without halting other operations
- **Independent environment variable polling** - Configuration updates detected asynchronously
- **Responsive command handling** - Inbound messages processed promptly
- **Clean separation of concerns** - Each subsystem manages itself

---

## FreeRTOS Task Architecture

### Task Overview

| Task | Priority | Stack (words) | Responsibility |
|------|----------|---------------|----------------|
| `MainTask` | Normal (2) | 512 | Orchestration, state machine, sleep coordination |
| `NotecardTask` | High (4) | 1024 | All Notecard I/O, note queuing, sync operations |
| `SensorTask` | Normal (2) | 512 | Periodic BME280 reads, alert detection |
| `AudioTask` | AboveNormal (3) | 256 | Non-blocking buzzer PWM, melody playback |
| `CommandTask` | AboveNormal (3) | 512 | Poll command.qi, execute inbound commands |
| `EnvTask` | BelowNormal (1) | 512 | Poll and apply environment variable changes |

### Task Communication

```
┌─────────────┐     audioQueue      ┌─────────────┐
│ SensorTask  │────────────────────▶│  AudioTask  │
│ CommandTask │                     │             │
│ MainTask    │                     └─────────────┘
└─────────────┘
       │
       │ noteQueue
       ▼
┌─────────────┐                     ┌─────────────┐
│NotecardTask │◀───────────────────▶│   EnvTask   │
│             │    i2cMutex         │             │
└─────────────┘                     └─────────────┘
       │
       │ configQueue
       ▼
┌─────────────┐
│  MainTask   │
│ (config rx) │
└─────────────┘
```

### Synchronization Primitives

| Primitive | Type | Purpose |
|-----------|------|---------|
| `i2cMutex` | Mutex | Protect shared I2C bus (Notecard + BME280) |
| `configMutex` | Mutex | Protect shared configuration struct |
| `audioQueue` | Queue (8 items) | Audio event requests → AudioTask |
| `noteQueue` | Queue (16 items) | Outbound notes → NotecardTask |
| `configQueue` | Queue (4 items) | Config updates → MainTask |
| `syncSemaphore` | Binary Semaphore | Signal sync completion |
| `sleepEvent` | Event Group | Coordinate task suspension for deep sleep |

---

## Project Structure

```
songbird-firmware/
├── songbird-firmware.ino        # Main sketch entry point
├── SongbirdConfig.h             # Configuration constants and pin definitions
├── SongbirdTasks.h              # FreeRTOS task declarations
├── SongbirdTasks.cpp            # Task implementations
├── SongbirdSync.h               # Mutexes, queues, semaphores, event groups
├── SongbirdSync.cpp             # Synchronization primitive initialization
├── SongbirdNotecard.h           # Notecard abstraction header
├── SongbirdNotecard.cpp         # Notecard implementation (thread-safe)
├── SongbirdSensors.h            # BME280 sensor header
├── SongbirdSensors.cpp          # BME280 sensor implementation
├── SongbirdAudio.h              # Buzzer/audio header
├── SongbirdAudio.cpp            # Buzzer/audio implementation
├── SongbirdMelodies.h           # Melody and tone definitions
├── SongbirdCommands.h           # Command handler header
├── SongbirdCommands.cpp         # Command handler implementation
├── SongbirdState.h              # State management header
├── SongbirdState.cpp            # State persistence implementation
├── SongbirdEnv.h                # Environment variable handler header
├── SongbirdEnv.cpp              # Environment variable implementation
├── FreeRTOSConfig.h             # FreeRTOS configuration
└── platformio.ini               # PlatformIO project config
```

---

## Implementation Phases

### Phase 1: Project Setup & FreeRTOS Foundation

**Goal:** Establish development environment with FreeRTOS and basic task structure.

#### Tasks

1. **Create PlatformIO project with FreeRTOS**
   - Configure `platformio.ini` for Cygnet board with FreeRTOS
   - Add library dependencies:
     - `blues/Blues Wireless Notecard@^1.6.0`
     - `adafruit/Adafruit BME280 Library@^2.2.2`
     - `adafruit/Adafruit Unified Sensor@^1.1.9`
   - Enable FreeRTOS in STM32 framework

2. **Implement FreeRTOSConfig.h**
   - Configure tick rate (1000 Hz recommended)
   - Set minimum stack size
   - Enable required features (queues, mutexes, semaphores, event groups)
   - Configure heap size (~20KB for task stacks and queues)

3. **Implement SongbirdSync module**
   - Create and initialize all synchronization primitives
   - `initSync()` - Create mutexes, queues, semaphores
   - Accessor functions for each primitive

4. **Implement SongbirdConfig.h**
   - Pin definitions (BUZZER_PIN PA8, LED_PIN PB5, BUTTON_PIN PA9)
   - Default configuration values
   - Notehub Product UID (`com.blues.songbird`)
   - Operating mode enums
   - Task priorities and stack sizes

5. **Create basic task skeleton**
   - Implement `SongbirdTasks.h/cpp` with empty task functions
   - Create all tasks in `setup()`
   - Verify FreeRTOS scheduler starts correctly

#### Deliverables
- Working PlatformIO project with FreeRTOS
- All tasks created and running (empty loops)
- Synchronization primitives initialized

---

### Phase 2: Notecard Task & Basic Connectivity

**Goal:** Implement thread-safe Notecard communication.

#### Tasks

1. **Implement thread-safe SongbirdNotecard module**
   - All functions acquire `i2cMutex` before Notecard access
   - `init()` - Initialize I2C and Notecard
   - `configure()` - Run `hub.set` with product UID and sync mode
   - `isConnected()` - Check hub status
   - `sync()` - Force immediate sync
   - `getVoltage()` - Read battery voltage via `card.voltage`
   - `getMotion()` - Check motion state via `card.motion`

2. **Implement NotecardTask**
   ```c
   void NotecardTask(void *pvParameters) {
       NoteQueueItem item;
       for (;;) {
           // Wait for items in note queue
           if (xQueueReceive(noteQueue, &item, pdMS_TO_TICKS(100))) {
               if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(1000))) {
                   // Process note (add to Notefile)
                   processNoteItem(&item);
                   xSemaphoreGive(i2cMutex);
               }
           }
           // Periodic sync check
           checkAndSync();
       }
   }
   ```

3. **Define note queue item structure**
   ```c
   typedef enum {
       NOTE_TYPE_TRACK,
       NOTE_TYPE_ALERT,
       NOTE_TYPE_CMD_ACK,
       NOTE_TYPE_HEALTH
   } NoteType;

   typedef struct {
       NoteType type;
       union {
           SensorData track;
           Alert alert;
           CommandAck ack;
           HealthData health;
       } data;
   } NoteQueueItem;
   ```

4. **Define Note templates**
   - `track.qo` template (~40 bytes per note)
   - `alert.qo` template
   - `command_ack.qo` template

#### Deliverables
- Thread-safe Notecard communication
- Note queue processing working
- Device connects to Notehub

---

### Phase 3: Sensor Task & Environmental Monitoring

**Goal:** Implement periodic sensor reading with thread-safe I2C access.

#### Tasks

1. **Implement thread-safe SongbirdSensors module**
   - Acquire `i2cMutex` for BME280 access
   - `init()` - Initialize BME280 on I2C (address 0x77)
   - `read()` - Read temperature, humidity, pressure
   - `SensorData` struct to hold readings
   - Error handling for sensor failures

2. **Implement SensorTask**
   ```c
   void SensorTask(void *pvParameters) {
       TickType_t lastWakeTime = xTaskGetTickCount();
       SensorData data;

       for (;;) {
           // Read sensors with mutex protection
           if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(1000))) {
               readSensors(&data);
               xSemaphoreGive(i2cMutex);
           }

           // Check alerts and queue audio if needed
           checkAndQueueAlerts(&data);

           // Queue track note
           queueTrackNote(&data);

           // Wait for next interval (configurable)
           vTaskDelayUntil(&lastWakeTime, pdMS_TO_TICKS(sensorIntervalMs));
       }
   }
   ```

3. **Implement alert checking**
   - Temperature high/low checks
   - Humidity high/low checks
   - Pressure delta tracking
   - Battery voltage low check
   - Queue audio events for alerts
   - Queue alert notes

#### Deliverables
- Sensor data flowing to Notehub
- Alert detection working
- Thread-safe I2C sharing between Notecard and BME280

---

### Phase 4: Audio Task & Non-Blocking Sound

**Goal:** Implement queue-based audio playback that doesn't block other tasks.

#### Tasks

1. **Implement SongbirdMelodies.h**
   - Note frequency definitions (C4-C6)
   - Melody arrays for each event:
     - `MELODY_POWER_ON` - Rising arpeggio C5→E5→G5→C6
     - `MELODY_CONNECTED` - Signature E5→G5→B5→C6
     - `MELODY_GPS_LOCK` - Two short G5 beeps
     - `MELODY_NOTE_SENT` - Single C6 chirp
     - `MELODY_MOTION` - Quick double E5 beeps
     - `MELODY_TEMP_ALERT` - Ascending C5→E5→G5
     - `MELODY_HUMIDITY_ALERT` - Descending G5→E5→C5
     - `MELODY_LOW_BATTERY` - Slow C5→A4→F4
     - `MELODY_BUTTON` - Click C6
     - `MELODY_SLEEP` - Descending fade C6→G5→C5
     - `MELODY_ERROR` - Low buzz 200Hz
     - `MELODY_PING` - Bright G5→C6→E6
     - `MELODY_LOCATE` - Repeating C6 beacon

2. **Define audio queue item**
   ```c
   typedef enum {
       AUDIO_EVENT_POWER_ON,
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
       AUDIO_EVENT_CUSTOM_TONE
   } AudioEventType;

   typedef struct {
       AudioEventType event;
       uint16_t frequency;    // For custom tone
       uint16_t durationMs;   // For custom tone
       uint16_t locateDurationSec; // For locate mode
   } AudioQueueItem;
   ```

3. **Implement AudioTask**
   ```c
   void AudioTask(void *pvParameters) {
       AudioQueueItem item;
       bool locateActive = false;
       TickType_t locateEndTime = 0;

       for (;;) {
           // Check for new audio events (non-blocking if in locate mode)
           TickType_t waitTime = locateActive ? pdMS_TO_TICKS(50) : portMAX_DELAY;

           if (xQueueReceive(audioQueue, &item, waitTime)) {
               if (item.event == AUDIO_EVENT_LOCATE_STOP) {
                   locateActive = false;
               } else if (item.event == AUDIO_EVENT_LOCATE_START) {
                   locateActive = true;
                   locateEndTime = xTaskGetTickCount() +
                                   pdMS_TO_TICKS(item.locateDurationSec * 1000);
               } else {
                   playAudioEvent(item.event);
               }
           }

           // Handle locate mode beeping
           if (locateActive) {
               if (xTaskGetTickCount() >= locateEndTime) {
                   locateActive = false;
               } else {
                   playLocateBeep();
                   vTaskDelay(pdMS_TO_TICKS(LOCATE_PAUSE_MS));
               }
           }
       }
   }
   ```

4. **Implement SongbirdAudio module**
   - `init()` - Configure PWM on PA8
   - `playTone(frequency, duration, volume)` - Single tone (blocking within task)
   - `playMelody(melody)` - Play full melody
   - `queueAudioEvent(event)` - Non-blocking, sends to queue
   - `setVolume(level)` - Set volume (0-100)
   - `setEnabled(enabled)` - Master enable/disable

5. **Helper function for other tasks**
   ```c
   // Called from any task - non-blocking
   void queueAudioEvent(AudioEventType event) {
       if (!audioEnabled) return;
       AudioQueueItem item = { .event = event };
       xQueueSend(audioQueue, &item, 0); // Don't block if queue full
   }
   ```

#### Deliverables
- Non-blocking audio playback
- All melodies working
- Locate mode with repeating pattern
- Audio respects enabled/volume settings

---

### Phase 5: Command Task & Cloud-to-Device Messaging

**Goal:** Handle inbound commands responsively.

#### Tasks

1. **Implement CommandTask**
   ```c
   void CommandTask(void *pvParameters) {
       for (;;) {
           // Check for commands (requires Notecard access)
           if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(1000))) {
               Command cmd;
               if (checkForCommand(&cmd)) {
                   xSemaphoreGive(i2cMutex);

                   // Execute command (may queue audio)
                   CommandResult result = executeCommand(&cmd);

                   // Queue acknowledgment
                   queueCommandAck(&cmd, &result);
               } else {
                   xSemaphoreGive(i2cMutex);
               }
           }

           // Poll interval (faster in demo mode)
           vTaskDelay(pdMS_TO_TICKS(commandPollIntervalMs));
       }
   }
   ```

2. **Implement command handlers**
   | Command | Handler | Action |
   |---------|---------|--------|
   | `ping` | `handlePing()` | Queue AUDIO_EVENT_PING |
   | `locate` | `handleLocate(duration)` | Queue AUDIO_EVENT_LOCATE_START |
   | `play_melody` | `handlePlayMelody(name)` | Queue appropriate audio event |
   | `test_audio` | `handleTestAudio(freq, dur)` | Queue custom tone |
   | `set_volume` | `handleSetVolume(level)` | Update audio volume |

3. **Implement SongbirdCommands module**
   - `checkForCommand()` - Poll command.qi via `note.get`
   - `executeCommand()` - Dispatch to appropriate handler
   - `queueCommandAck()` - Queue ack note to NotecardTask

#### Deliverables
- All commands functional from dashboard
- Responsive command handling (independent of sensor timing)
- Acknowledgments sent back to cloud

---

### Phase 6: Environment Variable Task

**Goal:** Independently monitor and apply configuration changes.

#### Tasks

1. **Implement EnvTask**
   ```c
   void EnvTask(void *pvParameters) {
       SongbirdConfig newConfig;

       for (;;) {
           // Fetch environment variables
           if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(1000))) {
               bool changed = fetchAndCompareConfig(&newConfig);
               xSemaphoreGive(i2cMutex);

               if (changed) {
                   // Send new config to MainTask
                   xQueueSend(configQueue, &newConfig, portMAX_DELAY);
               }
           }

           // Check less frequently than other tasks
           vTaskDelay(pdMS_TO_TICKS(envPollIntervalMs));
       }
   }
   ```

2. **Implement SongbirdEnv module**
   - `fetchConfig()` - Call `env.get` for all variables
   - `parseConfig()` - Convert strings to typed values
   - `compareConfig()` - Detect changes from current config
   - `applyModePreset()` - Apply mode-specific defaults

3. **Configuration structure**
   ```c
   typedef struct {
       uint8_t mode;              // demo, transit, storage, sleep
       uint16_t gpsIntervalMin;
       uint16_t syncIntervalMin;
       uint16_t heartbeatHours;
       float tempAlertHighC;
       float tempAlertLowC;
       float humidityAlertHigh;
       float humidityAlertLow;
       float pressureAlertDelta;
       float voltageAlertLow;
       uint8_t motionSensitivity;
       bool motionWakeEnabled;
       bool audioEnabled;
       uint8_t audioVolume;
       bool audioAlertsOnly;
       bool cmdWakeEnabled;
       bool cmdAckEnabled;
       uint16_t locateDurationSec;
       bool ledEnabled;
       bool debugMode;
   } SongbirdConfig;
   ```

4. **Config distribution to tasks**
   - MainTask receives config from queue
   - Updates shared config with mutex protection
   - Notifies other tasks of relevant changes

#### Deliverables
- Environment variables polled independently
- Configuration changes detected and applied
- Mode presets working

---

### Phase 7: Main Task & Orchestration

**Goal:** Coordinate all tasks and manage overall device state.

#### Tasks

1. **Implement MainTask**
   ```c
   void MainTask(void *pvParameters) {
       // Initial setup
       queueAudioEvent(AUDIO_EVENT_POWER_ON);

       bool coldBoot = !restoreState();
       if (coldBoot) {
           configureNotecard();
           setupTemplates();
       }

       // Wait for Notehub connection
       if (waitForConnection(30000)) {
           queueAudioEvent(AUDIO_EVENT_CONNECTED);
       }

       for (;;) {
           // Check for config updates
           SongbirdConfig newConfig;
           if (xQueueReceive(configQueue, &newConfig, 0)) {
               applyConfigUpdate(&newConfig);
           }

           // Monitor system health
           monitorHealth();

           // Check if sleep conditions met (all tasks idle)
           if (shouldEnterDeepSleep()) {
               coordinateDeepSleep();
           }

           vTaskDelay(pdMS_TO_TICKS(100));
       }
   }
   ```

2. **Implement state management**
   - `SongbirdState` struct for persistent data
   - `saveState()` - Encode and save to Notecard payload
   - `restoreState()` - Retrieve state after wake
   - State includes boot count, last sync, alert status, etc.

3. **Implement config distribution**
   - Receive config from EnvTask via queue
   - Update shared config (mutex protected)
   - Adjust task intervals based on new config
   - Update audio enabled/volume settings

#### Deliverables
- Coordinated task startup
- Configuration distribution working
- State management functional

---

### Phase 8: Power Management with FreeRTOS

**Goal:** Implement deep sleep coordination across all tasks.

#### Tasks

1. **Define sleep coordination event group**
   ```c
   #define SLEEP_BIT_SENSOR   (1 << 0)
   #define SLEEP_BIT_AUDIO    (1 << 1)
   #define SLEEP_BIT_COMMAND  (1 << 2)
   #define SLEEP_BIT_ENV      (1 << 3)
   #define SLEEP_BIT_NOTECARD (1 << 4)
   #define SLEEP_BITS_ALL     (0x1F)
   ```

2. **Implement coordinated sleep**
   ```c
   void coordinateDeepSleep(void) {
       // Signal all tasks to prepare for sleep
       sleepRequested = true;

       // Wait for all tasks to acknowledge
       EventBits_t bits = xEventGroupWaitBits(
           sleepEvent,
           SLEEP_BITS_ALL,
           pdTRUE,  // Clear on exit
           pdTRUE,  // Wait for all
           pdMS_TO_TICKS(5000)
       );

       if (bits == SLEEP_BITS_ALL) {
           // All tasks ready - play sleep tone synchronously
           playTone(NOTE_C6, 100, audioVolume);
           playTone(NOTE_G5, 100, audioVolume);
           playTone(NOTE_C5, 100, audioVolume);

           // Save state and configure ATTN
           saveStateAndSleep();
       } else {
           // Timeout - abort sleep
           sleepRequested = false;
       }
   }
   ```

3. **Task sleep acknowledgment pattern**
   ```c
   // In each task's main loop
   if (sleepRequested) {
       // Finish current operation
       // ...

       // Signal ready for sleep
       xEventGroupSetBits(sleepEvent, SLEEP_BIT_SENSOR);

       // Suspend self
       vTaskSuspend(NULL);
   }
   ```

4. **Implement ATTN-based sleep**
   - Configure `card.attn` with sleep, motion, files modes
   - Watch `command.qi` for wake on inbound commands
   - Save state to Notecard payload before sleep
   - Calculate sleep duration based on mode

5. **Wake handling**
   - On wake, all tasks resume automatically (fresh boot)
   - Detect wake source (timer, motion, command)
   - Restore state from Notecard payload
   - Resume appropriate behavior

#### Deliverables
- Coordinated deep sleep across all tasks
- Sleep current < 100µA
- Wake on timer, motion, and commands
- State preserved across sleep cycles

---

### Phase 9: GPS & Location

**Goal:** Configure GPS acquisition and include location in tracking notes.

#### Tasks

1. **Add GPS handling to NotecardTask**
   - Configure `card.location.mode` based on operating mode
   - Request location via `card.location`
   - Include location in track notes

2. **GPS status events**
   - Queue AUDIO_EVENT_GPS_LOCK when fix acquired
   - Track time since last GPS fix
   - Include GPS status in health notes

3. **Location data flow**
   - NotecardTask manages GPS requests
   - Location included automatically in templated notes
   - Tower location used as fallback

#### Deliverables
- GPS location in track notes
- Location visible on dashboard map
- GPS audio feedback working

---

### Phase 10: Testing & Optimization

**Goal:** Verify all functionality and optimize for FreeRTOS.

#### Tasks

1. **Functional testing**
   - Verify each task runs correctly
   - Test inter-task communication (queues working)
   - Test mutex protection (no I2C conflicts)
   - Test all audio events (non-blocking)
   - Test all commands
   - Test configuration changes
   - Test sleep/wake cycles

2. **Stack usage analysis**
   - Use `uxTaskGetStackHighWaterMark()` for each task
   - Adjust stack sizes based on actual usage
   - Ensure adequate headroom

3. **Power profiling**
   - Measure active current with all tasks running
   - Measure sleep current
   - Profile task CPU usage
   - Optimize task intervals

4. **Timing verification**
   - Command response latency
   - Audio playback start latency
   - Sensor read intervals
   - Sync timing

5. **Edge cases**
   - Queue overflow handling
   - Mutex timeout handling
   - Task starvation prevention
   - Rapid command sequences

#### Deliverables
- All features verified
- Stack sizes optimized
- Power consumption meets targets
- Robust error handling

---

## File Implementation Details

### platformio.ini

```ini
[env:cygnet]
platform = ststm32
board = cygnet
framework = arduino
lib_deps =
    blues/Blues Wireless Notecard@^1.6.0
    adafruit/Adafruit BME280 Library@^2.2.2
    adafruit/Adafruit Unified Sensor@^1.1.9
upload_protocol = stlink
monitor_speed = 115200
build_flags =
    -D PRODUCT_UID=\"com.blues.songbird\"
    -D FIRMWARE_VERSION=\"1.0.0\"
    -D HAL_TIM_MODULE_ENABLED
    ; FreeRTOS configuration
    -D configUSE_PREEMPTION=1
    -D configUSE_IDLE_HOOK=0
    -D configUSE_TICK_HOOK=0
    -D configCPU_CLOCK_HZ=80000000
    -D configTICK_RATE_HZ=1000
    -D configMAX_PRIORITIES=5
    -D configMINIMAL_STACK_SIZE=128
    -D configTOTAL_HEAP_SIZE=20480
    -D configMAX_TASK_NAME_LEN=16
    -D configUSE_MUTEXES=1
    -D configUSE_COUNTING_SEMAPHORES=1
    -D configUSE_QUEUE_SETS=0
    -D configQUEUE_REGISTRY_SIZE=8
    -D configUSE_EVENT_GROUPS=1
```

### FreeRTOSConfig.h (Key Settings)

```c
#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

// Provided via build_flags, but documented here for reference
#define configUSE_PREEMPTION                    1
#define configUSE_PORT_OPTIMISED_TASK_SELECTION 1
#define configCPU_CLOCK_HZ                      80000000
#define configTICK_RATE_HZ                      1000
#define configMAX_PRIORITIES                    5
#define configMINIMAL_STACK_SIZE                128
#define configTOTAL_HEAP_SIZE                   (20 * 1024)
#define configMAX_TASK_NAME_LEN                 16
#define configUSE_MUTEXES                       1
#define configUSE_COUNTING_SEMAPHORES           1
#define configUSE_EVENT_GROUPS                  1
#define configUSE_TRACE_FACILITY                1
#define configUSE_STATS_FORMATTING_FUNCTIONS    1

// Hook functions (for debugging/power management)
#define configUSE_IDLE_HOOK                     0
#define configUSE_TICK_HOOK                     0
#define configCHECK_FOR_STACK_OVERFLOW          2

// Cortex-M4 specific
#define configPRIO_BITS                         4
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY 15
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5
#define configKERNEL_INTERRUPT_PRIORITY         (configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))
#define configMAX_SYSCALL_INTERRUPT_PRIORITY    (configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))

#endif
```

### SongbirdConfig.h Key Definitions

```c
#ifndef SONGBIRD_CONFIG_H
#define SONGBIRD_CONFIG_H

// Pin Definitions
#define BUZZER_PIN      PA8     // Timer 1, Channel 1 (PWM capable)
#define BUTTON_PIN      USR_BTN // User button (optional)
#define LED_PIN         PB5     // Built-in LED on Cygnet

// I2C Configuration
#define BME280_ADDRESS  0x77    // SparkFun/Adafruit default
#define NOTECARD_I2C_ADDRESS 0x17

// Task Priorities (higher = more important)
#define PRIORITY_MAIN       2
#define PRIORITY_SENSOR     2
#define PRIORITY_AUDIO      3
#define PRIORITY_COMMAND    3
#define PRIORITY_NOTECARD   4
#define PRIORITY_ENV        1

// Task Stack Sizes (words, not bytes)
#define STACK_MAIN          512
#define STACK_SENSOR        512
#define STACK_AUDIO         256
#define STACK_COMMAND       512
#define STACK_NOTECARD      1024
#define STACK_ENV           512

// Queue Sizes
#define AUDIO_QUEUE_SIZE    8
#define NOTE_QUEUE_SIZE     16
#define CONFIG_QUEUE_SIZE   4

// Operating Modes
typedef enum {
    MODE_DEMO = 0,
    MODE_TRANSIT = 1,
    MODE_STORAGE = 2,
    MODE_SLEEP = 3
} OperatingMode;

// Motion Sensitivity
typedef enum {
    MOTION_LOW = 0,
    MOTION_MEDIUM = 1,
    MOTION_HIGH = 2
} MotionSensitivity;

// Alert Types
#define ALERT_TEMP_HIGH     "temp_high"
#define ALERT_TEMP_LOW      "temp_low"
#define ALERT_HUMIDITY_HIGH "humidity_high"
#define ALERT_HUMIDITY_LOW  "humidity_low"
#define ALERT_PRESSURE_DELTA "pressure_change"
#define ALERT_LOW_BATTERY   "low_battery"
#define ALERT_MOTION        "motion"

// Notefiles
#define NOTEFILE_TRACK      "track.qo"
#define NOTEFILE_ALERT      "alert.qo"
#define NOTEFILE_COMMAND    "command.qi"
#define NOTEFILE_CMD_ACK    "command_ack.qo"
#define NOTEFILE_HEALTH     "health.qo"

// Default Configuration
#define DEFAULT_MODE                MODE_DEMO
#define DEFAULT_GPS_INTERVAL_MIN    5
#define DEFAULT_SYNC_INTERVAL_MIN   15
#define DEFAULT_HEARTBEAT_HOURS     24
#define DEFAULT_TEMP_ALERT_HIGH     35.0f
#define DEFAULT_TEMP_ALERT_LOW      0.0f
#define DEFAULT_HUMIDITY_HIGH       80.0f
#define DEFAULT_HUMIDITY_LOW        20.0f
#define DEFAULT_PRESSURE_DELTA      10.0f
#define DEFAULT_VOLTAGE_LOW         3.4f
#define DEFAULT_MOTION_SENSITIVITY  MOTION_MEDIUM
#define DEFAULT_AUDIO_VOLUME        80
#define DEFAULT_LOCATE_DURATION     30

// Task Intervals (ms) - adjusted per mode
#define SENSOR_INTERVAL_DEMO_MS     10000   // 10 seconds
#define SENSOR_INTERVAL_TRANSIT_MS  60000   // 1 minute
#define SENSOR_INTERVAL_STORAGE_MS  300000  // 5 minutes
#define COMMAND_POLL_DEMO_MS        1000    // 1 second
#define COMMAND_POLL_TRANSIT_MS     5000    // 5 seconds
#define ENV_POLL_INTERVAL_MS        30000   // 30 seconds

#endif
```

### SongbirdSync.h

```c
#ifndef SONGBIRD_SYNC_H
#define SONGBIRD_SYNC_H

#include <FreeRTOS.h>
#include <semphr.h>
#include <queue.h>
#include <event_groups.h>

// Synchronization primitives
extern SemaphoreHandle_t i2cMutex;
extern SemaphoreHandle_t configMutex;
extern QueueHandle_t audioQueue;
extern QueueHandle_t noteQueue;
extern QueueHandle_t configQueue;
extern SemaphoreHandle_t syncSemaphore;
extern EventGroupHandle_t sleepEvent;

// Sleep event bits
#define SLEEP_BIT_SENSOR   (1 << 0)
#define SLEEP_BIT_AUDIO    (1 << 1)
#define SLEEP_BIT_COMMAND  (1 << 2)
#define SLEEP_BIT_ENV      (1 << 3)
#define SLEEP_BIT_NOTECARD (1 << 4)
#define SLEEP_BITS_ALL     (0x1F)

// Global sleep request flag
extern volatile bool sleepRequested;

// Initialize all synchronization primitives
void initSync(void);

#endif
```

---

## Memory Budget

| Component | RAM Usage |
|-----------|-----------|
| FreeRTOS Heap | 20 KB |
| MainTask Stack | 2 KB |
| SensorTask Stack | 2 KB |
| AudioTask Stack | 1 KB |
| CommandTask Stack | 2 KB |
| NotecardTask Stack | 4 KB |
| EnvTask Stack | 2 KB |
| Queues (~500 bytes) | 0.5 KB |
| Global Variables | ~1 KB |
| **Total** | **~35 KB** |

Cygnet has 64 KB RAM, leaving ~29 KB headroom for library usage and stack growth.

---

## Dependencies & Prerequisites

### Hardware Required
- Blues Cygnet MCU
- Notecarrier-F v1.3+ (with DIP 1 ON for ATTN→EN)
- Notecard Cell+WiFi (NBGL)
- BME280 Qwiic breakout
- Passive piezo buzzer
- 3.7V 2000mAh LiPo battery
- Cellular and GPS antennas

### Software Required
- PlatformIO Core or VS Code with PlatformIO extension
- STM32CubeProgrammer (for STLINK upload)
- STLINK-V3MINI debugger

### Notehub Setup
- Product UID: `com.blues.songbird`
- Fleets configured per PRD section 5.1.2
- Environment variables set at project level (defaults)
- Routes configured to AWS IoT Core

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Time to first data | < 3 minutes from power-on |
| Sleep current | < 100µA |
| Battery life (transit) | > 14 days |
| Battery life (storage) | > 60 days |
| GPS warm fix time | < 60 seconds |
| Command latency (demo) | < 2 seconds |
| Audio start latency | < 100ms from event |
| All audio events | Distinct and audible |
| All env vars | Configurable remotely |
| All commands | Functional from dashboard |
| Stack overflow | None detected |

---

## Notes

- FreeRTOS adds ~10-15KB code size and ~6KB RAM overhead vs simple loop
- All I2C access MUST use `i2cMutex` to prevent bus conflicts
- Audio queue allows fire-and-forget audio from any task
- Deep sleep requires coordinating all tasks via event group
- Task priorities chosen to ensure responsive audio and commands
- NotecardTask has highest priority since it handles time-sensitive sync operations
- EnvTask has lowest priority since configuration changes are not time-critical
