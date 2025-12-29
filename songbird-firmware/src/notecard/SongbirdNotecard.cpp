/**
 * @file SongbirdNotecard.cpp
 * @brief Notecard communication implementation
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdNotecard.h"
#include "SongbirdState.h"
#include <Wire.h>
#include <STM32FreeRTOS.h>

// =============================================================================
// Module State
// =============================================================================

static Notecard s_notecard;
static bool s_initialized = false;
static uint32_t s_errorCount = 0;
static uint32_t s_lastEnvModCount = 0;

// =============================================================================
// Helper Macros
// =============================================================================

#define NC_ERROR() do { s_errorCount++; } while(0)

// =============================================================================
// Initialization
// =============================================================================

bool notecardInit(void) {
    s_notecard.begin();

    // Verify Notecard is responding
    J* req = s_notecard.newRequest("card.version");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Not responding");
        #endif
        NC_ERROR();
        return false;
    }

    if (s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Version request failed");
        #endif
        s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    #ifdef DEBUG_MODE
    const char* version = JGetString(rsp, "version");
    DEBUG_SERIAL.print("[Notecard] Version: ");
    DEBUG_SERIAL.println(version ? version : "unknown");
    #endif

    s_notecard.deleteResponse(rsp);
    s_initialized = true;
    s_errorCount = 0;

    return true;
}

bool notecardIsAvailable(void) {
    return s_initialized;
}

Notecard* notecardGetInstance(void) {
    return &s_notecard;
}

// =============================================================================
// Configuration
// =============================================================================

bool notecardConfigure(OperatingMode mode) {
    if (!s_initialized) {
        return false;
    }

    // Configure hub.set
    J* req = s_notecard.newRequest("hub.set");
    JAddStringToObject(req, "product", PRODUCT_UID);
    JAddStringToObject(req, "sn", "songbird");  // Will be overwritten by Notehub

    // Set mode based on operating mode
    switch (mode) {
        case MODE_DEMO:
            JAddStringToObject(req, "mode", "continuous");
            JAddBoolToObject(req, "sync", true);  // Immediate sync
            JAddNumberToObject(req, "outbound", 1);  // 1 minute
            JAddNumberToObject(req, "inbound", 1440);  // 24 hours (sync:true handles immediate)
            JAddNumberToObject(req, "duration", 15);
            break;
        case MODE_TRANSIT:
            JAddStringToObject(req, "mode", "periodic");
            JAddNumberToObject(req, "outbound", 10);  // 10 minutes
            JAddNumberToObject(req, "inbound", DEFAULT_SYNC_INTERVAL_MIN);
            break;
        case MODE_STORAGE:
            JAddStringToObject(req, "mode", "periodic");
            JAddNumberToObject(req, "outbound", 60);
            JAddNumberToObject(req, "inbound", 60);
            break;
        case MODE_SLEEP:
            JAddStringToObject(req, "mode", "minimum");
            break;
    }

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] hub.set failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }
    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] Configured for mode ");
    DEBUG_SERIAL.println(mode);
    #endif

    // Configure Mojo power monitoring (periodic readings)
    // Mojo is automatically detected if connected before Notecard power-on
    // Note: Mojo monitoring may be disabled later if USB power is detected
    notecardConfigureMojo(true, mode);

    // Enable Outboard DFU and report firmware version
    // These calls enable over-the-air firmware updates via Notehub
    if (!notecardEnableODFU()) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Warning: ODFU setup failed");
        #endif
        // Continue anyway - ODFU is optional but recommended
    }

    if (!notecardReportFirmwareVersion()) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Warning: Version reporting failed");
        #endif
        // Continue anyway
    }

    // Enable cell tower and Wi-Fi triangulation for location
    // This provides location even when GPS is off (demo mode) or unavailable
    if (!notecardConfigureTriangulation()) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Warning: Triangulation setup failed");
        #endif
        // Continue anyway - triangulation is optional but improves location coverage
    }

    // Configure voltage monitoring for LiPo battery
    // This must be done before GPS/tracking to ensure accurate battery readings
    if (!notecardConfigureVoltage()) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Warning: Voltage configuration failed");
        #endif
        // Continue anyway - voltage readings will still work, just less accurate
    }

    // Configure GPS mode based on operating mode
    if (!notecardConfigureGPS(mode)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Warning: GPS configuration failed");
        #endif
        // Continue anyway
    }

    // Configure location tracking (only enabled in transit mode)
    if (!notecardConfigureTracking(mode)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] Warning: Tracking configuration failed");
        #endif
        // Continue anyway
    }

    return true;
}

bool notecardSetupTemplates(void) {
    if (!s_initialized) {
        return false;
    }

    bool success = true;

    // Template for track.qo
    {
        J* req = s_notecard.newRequest("note.template");
        JAddStringToObject(req, "file", NOTEFILE_TRACK);
        JAddStringToObject(req, "format", "compact");
        JAddNumberToObject(req, "port", 10);

        J* body = JCreateObject();
        JAddNumberToObject(body, "temp", TFLOAT32);
        JAddNumberToObject(body, "humidity", TFLOAT32);
        JAddNumberToObject(body, "pressure", TFLOAT32);
        JAddNumberToObject(body, "voltage", TFLOAT32);
        JAddNumberToObject(body, "_time", TINT32);
        JAddBoolToObject(body, "motion", TBOOL);
        JAddStringToObject(body, "mode", "xxxxxxxxxxxx");  // 12 char max
        JAddBoolToObject(body, "transit_locked", TBOOL);
        JAddBoolToObject(body, "demo_locked", TBOOL);
        JAddItemToObject(req, "body", body);

        J* rsp = s_notecard.requestAndResponse(req);
        if (rsp == NULL || s_notecard.responseError(rsp)) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.print("[Notecard] track.qo template failed: ");
            if (rsp) {
                const char* err = JGetString(rsp, "err");
                DEBUG_SERIAL.println(err ? err : "unknown error");
            } else {
                DEBUG_SERIAL.println("no response");
            }
            #endif
            success = false;
            NC_ERROR();
        }
        if (rsp) s_notecard.deleteResponse(rsp);
    }

    // Template for alert.qo
    {
        J* req = s_notecard.newRequest("note.template");
        JAddStringToObject(req, "file", NOTEFILE_ALERT);
        JAddStringToObject(req, "format", "compact");
        JAddNumberToObject(req, "port", 11);

        J* body = JCreateObject();
        JAddStringToObject(body, "type", "xxxxxxxxxxxxxxxx");  // 16 char max
        JAddNumberToObject(body, "value", TFLOAT32);
        JAddNumberToObject(body, "threshold", TFLOAT32);
        JAddNumberToObject(body, "_time", TINT32);
        // 64 char placeholder for message
        JAddStringToObject(body, "message", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        JAddItemToObject(req, "body", body);

        J* rsp = s_notecard.requestAndResponse(req);
        if (rsp == NULL || s_notecard.responseError(rsp)) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.print("[Notecard] alert.qo template failed: ");
            if (rsp) {
                const char* err = JGetString(rsp, "err");
                DEBUG_SERIAL.println(err ? err : "unknown error");
            } else {
                DEBUG_SERIAL.println("no response");
            }
            #endif
            success = false;
            NC_ERROR();
        }
        if (rsp) s_notecard.deleteResponse(rsp);
    }

    // Template for command_ack.qo
    {
        J* req = s_notecard.newRequest("note.template");
        JAddStringToObject(req, "file", NOTEFILE_CMD_ACK);
        JAddStringToObject(req, "format", "compact");
        JAddNumberToObject(req, "port", 12);

        J* body = JCreateObject();
        JAddStringToObject(body, "cmd_id", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");  // 32 char max
        JAddStringToObject(body, "cmd", "xxxxxxxxxxxxxxxx");  // 16 char max
        JAddStringToObject(body, "status", "xxxxxxxx");  // 8 char max
        // 64 char placeholder for message
        JAddStringToObject(body, "message", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        JAddNumberToObject(body, "executed_at", TUINT32);
        JAddNumberToObject(body, "_time", TINT32);
        JAddItemToObject(req, "body", body);

        J* rsp = s_notecard.requestAndResponse(req);
        if (rsp == NULL || s_notecard.responseError(rsp)) {
            #ifdef DEBUG_MODE
            DEBUG_SERIAL.print("[Notecard] command_ack.qo template failed: ");
            if (rsp) {
                const char* err = JGetString(rsp, "err");
                DEBUG_SERIAL.println(err ? err : "unknown error");
            } else {
                DEBUG_SERIAL.println("no response");
            }
            #endif
            success = false;
            NC_ERROR();
        }
        if (rsp) s_notecard.deleteResponse(rsp);
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println(success ? "[Notecard] Templates configured" : "[Notecard] Template setup failed");
    #endif

    return success;
}

// =============================================================================
// Connection Status
// =============================================================================

bool notecardIsConnected(void) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("hub.status");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL) {
        NC_ERROR();
        return false;
    }

    bool connected = JGetBool(rsp, "connected");
    s_notecard.deleteResponse(rsp);

    return connected;
}

bool notecardWaitConnection(uint32_t timeoutMs) {
    uint32_t start = millis();

    while ((millis() - start) < timeoutMs) {
        if (notecardIsConnected()) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    return false;
}

bool notecardSync(void) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("hub.sync");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);
    return true;
}

bool notecardIsSyncing(void) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("hub.sync.status");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL) {
        return false;
    }

    // Check if sync is requested or in progress
    const char* status = JGetString(rsp, "status");
    bool syncing = (status != NULL && strlen(status) > 0);

    s_notecard.deleteResponse(rsp);
    return syncing;
}

// =============================================================================
// Note Operations
// =============================================================================

bool notecardSendTrackNote(const SensorData* data, OperatingMode mode, bool forceSync) {
    if (!s_initialized || data == NULL) {
        return false;
    }

    J* req = s_notecard.newRequest("note.add");
    JAddStringToObject(req, "file", NOTEFILE_TRACK);
    // Immediate sync in demo mode or when forced (e.g., mode changes)
    JAddBoolToObject(req, "sync", mode == MODE_DEMO || forceSync);

    J* body = JCreateObject();
    JAddNumberToObject(body, "temp", data->temperature);
    JAddNumberToObject(body, "humidity", data->humidity);
    JAddNumberToObject(body, "pressure", data->pressure);
    JAddNumberToObject(body, "voltage", data->voltage);
    JAddBoolToObject(body, "motion", data->motion);

    const char* modeStr = "unknown";
    switch (mode) {
        case MODE_DEMO: modeStr = "demo"; break;
        case MODE_TRANSIT: modeStr = "transit"; break;
        case MODE_STORAGE: modeStr = "storage"; break;
        case MODE_SLEEP: modeStr = "sleep"; break;
    }
    JAddStringToObject(body, "mode", modeStr);
    if (stateIsTransitLocked()) {
        JAddBoolToObject(body, "transit_locked", true);
    }
    if (stateIsDemoLocked()) {
        JAddBoolToObject(body, "demo_locked", true);
    }
    JAddItemToObject(req, "body", body);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Notecard] Track note sent");
    #endif

    return true;
}

bool notecardSendAlertNote(const Alert* alert) {
    if (!s_initialized || alert == NULL) {
        return false;
    }

    J* req = s_notecard.newRequest("note.add");
    JAddStringToObject(req, "file", NOTEFILE_ALERT);
    JAddBoolToObject(req, "sync", true);  // Always sync alerts immediately

    J* body = JCreateObject();
    JAddStringToObject(body, "type", alert->type);
    JAddNumberToObject(body, "value", alert->value);
    JAddNumberToObject(body, "threshold", alert->threshold);
    JAddStringToObject(body, "message", alert->message);
    JAddItemToObject(req, "body", body);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] Alert note sent: ");
    DEBUG_SERIAL.println(alert->type);
    #endif

    return true;
}

bool notecardSendCommandAck(const CommandAck* ack) {
    if (!s_initialized || ack == NULL) {
        return false;
    }

    J* req = s_notecard.newRequest("note.add");
    JAddStringToObject(req, "file", NOTEFILE_CMD_ACK);
    JAddBoolToObject(req, "sync", true);

    J* body = JCreateObject();
    JAddStringToObject(body, "cmd_id", ack->commandId);

    const char* cmdStr = "unknown";
    switch (ack->type) {
        case CMD_PING: cmdStr = "ping"; break;
        case CMD_LOCATE: cmdStr = "locate"; break;
        case CMD_PLAY_MELODY: cmdStr = "play_melody"; break;
        case CMD_TEST_AUDIO: cmdStr = "test_audio"; break;
        case CMD_SET_VOLUME: cmdStr = "set_volume"; break;
        default: break;
    }
    JAddStringToObject(body, "cmd", cmdStr);

    const char* statusStr = "ok";
    switch (ack->status) {
        case CMD_STATUS_OK: statusStr = "ok"; break;
        case CMD_STATUS_ERROR: statusStr = "error"; break;
        case CMD_STATUS_IGNORED: statusStr = "ignored"; break;
    }
    JAddStringToObject(body, "status", statusStr);
    JAddStringToObject(body, "message", ack->message);
    JAddNumberToObject(body, "executed_at", ack->executedAt);
    JAddItemToObject(req, "body", body);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);
    return true;
}

bool notecardSendHealthNote(const HealthData* health) {
    if (!s_initialized || health == NULL) {
        return false;
    }

    J* req = s_notecard.newRequest("note.add");
    JAddStringToObject(req, "file", NOTEFILE_HEALTH);

    J* body = JCreateObject();
    JAddStringToObject(body, "firmware", health->firmwareVersion);
    JAddNumberToObject(body, "uptime_sec", health->uptimeSec);
    JAddNumberToObject(body, "boot_count", health->bootCount);
    JAddNumberToObject(body, "last_gps_fix_sec", health->lastGpsFixSec);
    JAddNumberToObject(body, "sensor_errors", health->sensorErrors);
    JAddNumberToObject(body, "notecard_errors", health->notecardErrors);
    JAddItemToObject(req, "body", body);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);
    return true;
}

// =============================================================================
// Command Reception
// =============================================================================

bool notecardGetCommand(Command* cmd) {
    if (!s_initialized || cmd == NULL) {
        return false;
    }

    // Check for notes in command.qi
    J* req = s_notecard.newRequest("note.get");
    JAddStringToObject(req, "file", NOTEFILE_COMMAND);
    JAddBoolToObject(req, "delete", true);  // Delete after reading

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL) {
        return false;
    }

    // Check for "note" error which means no notes available
    if (s_notecard.responseError(rsp)) {
        s_notecard.deleteResponse(rsp);
        return false;
    }

    // Parse command from note body
    J* body = JGetObject(rsp, "body");
    if (body == NULL) {
        s_notecard.deleteResponse(rsp);
        return false;
    }

    // Get command ID if present
    const char* cmdId = JGetString(body, "command_id");
    if (cmdId) {
        strncpy(cmd->commandId, cmdId, sizeof(cmd->commandId) - 1);
    } else {
        cmd->commandId[0] = '\0';
    }

    // Parse command type
    const char* cmdStr = JGetString(body, "cmd");
    cmd->type = CMD_UNKNOWN;

    if (cmdStr != NULL) {
        if (strcmp(cmdStr, "ping") == 0) {
            cmd->type = CMD_PING;
        } else if (strcmp(cmdStr, "locate") == 0) {
            cmd->type = CMD_LOCATE;
            J* params = JGetObject(body, "params");
            if (params) {
                cmd->params.locate.durationSec = JGetInt(params, "duration_sec");
                if (cmd->params.locate.durationSec == 0) {
                    cmd->params.locate.durationSec = DEFAULT_LOCATE_DURATION_SEC;
                }
            } else {
                cmd->params.locate.durationSec = DEFAULT_LOCATE_DURATION_SEC;
            }
        } else if (strcmp(cmdStr, "play_melody") == 0) {
            cmd->type = CMD_PLAY_MELODY;
            J* params = JGetObject(body, "params");
            if (params) {
                const char* melody = JGetString(params, "melody");
                if (melody) {
                    strncpy(cmd->params.playMelody.melodyName, melody,
                            sizeof(cmd->params.playMelody.melodyName) - 1);
                }
            }
        } else if (strcmp(cmdStr, "test_audio") == 0) {
            cmd->type = CMD_TEST_AUDIO;
            J* params = JGetObject(body, "params");
            if (params) {
                cmd->params.testAudio.frequency = JGetInt(params, "frequency");
                cmd->params.testAudio.durationMs = JGetInt(params, "duration_ms");
            }
        } else if (strcmp(cmdStr, "set_volume") == 0) {
            cmd->type = CMD_SET_VOLUME;
            J* params = JGetObject(body, "params");
            if (params) {
                cmd->params.setVolume.volume = JGetInt(params, "volume");
            }
        }
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] Command received: ");
    DEBUG_SERIAL.println(cmdStr ? cmdStr : "unknown");
    #endif

    return true;
}

// =============================================================================
// Device Information
// =============================================================================

float notecardGetVoltage(bool* usbPowered) {
    if (!s_initialized) {
        if (usbPowered) *usbPowered = false;
        return 0.0f;
    }

    J* req = s_notecard.newRequest("card.voltage");

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        if (usbPowered) *usbPowered = false;
        NC_ERROR();
        return 0.0f;
    }

    float voltage = JGetNumber(rsp, "value");

    // Check USB power status - "usb":true means device is USB powered
    if (usbPowered) {
        *usbPowered = JGetBool(rsp, "usb");
    }

    s_notecard.deleteResponse(rsp);

    return voltage;
}

bool notecardConfigureVoltage(void) {
    if (!s_initialized) {
        return false;
    }

    // Configure voltage monitoring for LiPo battery
    // See: https://dev.blues.io/api-reference/notecard-api/card-requests/#card-voltage
    J* req = s_notecard.newRequest("card.voltage");

    // Set mode to "lipo" for accurate LiPo battery discharge curve
    // This enables voltage-variable behaviors based on battery state
    JAddStringToObject(req, "mode", "lipo");

    // Enable voltage alerts - Notecard will generate _health.qo events
    // when battery reaches low/critical levels
    JAddBoolToObject(req, "alert", true);

    // Sync immediately when voltage alerts occur
    // This ensures low battery warnings reach the cloud right away
    JAddBoolToObject(req, "sync", true);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] card.voltage config failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Notecard] Voltage monitoring configured (lipo mode, alerts enabled)");
    #endif

    return true;
}

bool notecardConfigureMojo(bool enabled, OperatingMode mode) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.power");

    if (enabled) {
        // Set periodic reading interval based on mode
        switch (mode) {
            case MODE_DEMO:
                JAddNumberToObject(req, "minutes", 1);  // Every minute for demo
                break;
            case MODE_TRANSIT:
                JAddNumberToObject(req, "minutes", 5);  // Every 5 minutes
                break;
            case MODE_STORAGE:
                JAddNumberToObject(req, "minutes", 60); // Every hour
                break;
            case MODE_SLEEP:
                JAddNumberToObject(req, "minutes", 720);  // 12 hours for max reading time
                break;
        }
    } else {
        // Disable Mojo power monitoring
        JAddNumberToObject(req, "minutes", 720);  // 12 hours for max reading time
    }

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] card.power config failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        return false;
    }

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] Mojo power monitoring ");
    DEBUG_SERIAL.println(enabled ? "enabled" : "disabled");
    #endif

    s_notecard.deleteResponse(rsp);
    return true;
}

bool notecardGetMotion(void) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.motion");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        return false;
    }

    bool motion = JGetBool(rsp, "motion");
    s_notecard.deleteResponse(rsp);

    return motion;
}

bool notecardSetMotionSensitivity(MotionSensitivity sensitivity) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.motion.mode");
    JAddBoolToObject(req, "start", true);

    double threshold;
    switch (sensitivity) {
        case MOTION_SENSITIVITY_LOW:
            threshold = MOTION_THRESHOLD_LOW;
            break;
        case MOTION_SENSITIVITY_HIGH:
            threshold = MOTION_THRESHOLD_HIGH;
            break;
        default:
            threshold = MOTION_THRESHOLD_MEDIUM;
            break;
    }
    JAddNumberToObject(req, "sensitivity", threshold);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);
    return true;
}

bool notecardGetSerial(char* buffer, size_t bufferSize) {
    if (!s_initialized || buffer == NULL || bufferSize == 0) {
        return false;
    }

    J* req = s_notecard.newRequest("card.version");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        return false;
    }

    const char* sn = JGetString(rsp, "device");
    if (sn) {
        strncpy(buffer, sn, bufferSize - 1);
        buffer[bufferSize - 1] = '\0';
    } else {
        buffer[0] = '\0';
    }

    s_notecard.deleteResponse(rsp);
    return sn != NULL;
}

// =============================================================================
// GPS/Location
// =============================================================================

bool notecardConfigureGPS(OperatingMode mode) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.location.mode");

    switch (mode) {
        case MODE_DEMO:
            // GPS off in demo - rely on triangulation only
            JAddStringToObject(req, "mode", "off");
            break;
        case MODE_TRANSIT:
            // GPS enabled for tracking - 60 second interval for good track resolution
            JAddStringToObject(req, "mode", "periodic");
            JAddNumberToObject(req, "seconds", 60);
            break;
        case MODE_STORAGE:
            // GPS off in storage - triangulation provides sufficient location
            JAddStringToObject(req, "mode", "off");
            break;
        case MODE_SLEEP:
            // GPS off when sleeping
            JAddStringToObject(req, "mode", "off");
            break;
    }

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] GPS mode configured for ");
    DEBUG_SERIAL.println(mode == MODE_TRANSIT ? "transit (periodic 60s)" : "off");
    #endif

    return true;
}

bool notecardConfigureTracking(OperatingMode mode) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.location.track");

    if (mode == MODE_TRANSIT) {
        // Enable autonomous GPS tracking in transit mode
        // The Notecard will automatically record location to _track.qo
        // when motion is detected, with velocity, bearing, and distance
        JAddBoolToObject(req, "start", true);
        JAddBoolToObject(req, "heartbeat", true);  // Send updates even when stationary
        JAddNumberToObject(req, "hours", 1);       // Heartbeat every hour if no motion
        JAddBoolToObject(req, "sync", true);       // Sync immediately on each track note
    } else {
        // Disable tracking for all other modes to conserve power
        JAddBoolToObject(req, "stop", true);
    }

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] card.location.track failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] Location tracking ");
    DEBUG_SERIAL.println(mode == MODE_TRANSIT ? "enabled" : "disabled");
    #endif

    return true;
}

bool notecardConfigureTriangulation(void) {
    if (!s_initialized) {
        return false;
    }

    // Enable cell tower and Wi-Fi triangulation for location
    // This provides location data when GPS is off or unavailable
    J* req = s_notecard.newRequest("card.triangulate");

    // Enable both wifi and cell triangulation (Cell+WiFi Notecard)
    JAddStringToObject(req, "mode", "wifi,cell");

    // Always triangulate regardless of motion state
    // This ensures we get location even when device is stationary
    JAddBoolToObject(req, "set", true);
    JAddBoolToObject(req, "on", true);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] card.triangulate failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Notecard] Triangulation enabled (wifi,cell)");
    #endif

    return true;
}

bool notecardGetGPSStatus(bool* hasLock, double* lat, double* lon, uint32_t* timeSeconds) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.location");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        if (hasLock) *hasLock = false;
        return false;
    }

    if (hasLock) {
        *hasLock = JGetNumber(rsp, "lat") != 0 || JGetNumber(rsp, "lon") != 0;
    }
    if (lat) *lat = JGetNumber(rsp, "lat");
    if (lon) *lon = JGetNumber(rsp, "lon");
    if (timeSeconds) *timeSeconds = JGetInt(rsp, "time");

    s_notecard.deleteResponse(rsp);
    return true;
}

// =============================================================================
// Environment Variables
// =============================================================================

bool notecardEnvGet(const char* name, char* buffer, size_t bufferSize) {
    if (!s_initialized || name == NULL || buffer == NULL || bufferSize == 0) {
        return false;
    }

    J* req = s_notecard.newRequest("env.get");
    JAddStringToObject(req, "name", name);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        return false;
    }

    const char* value = JGetString(rsp, "text");
    // Only return true if value exists AND is not empty
    // Empty string means the env var is not set
    if (value && value[0] != '\0') {
        strncpy(buffer, value, bufferSize - 1);
        buffer[bufferSize - 1] = '\0';
        s_notecard.deleteResponse(rsp);
        return true;
    }

    s_notecard.deleteResponse(rsp);
    return false;
}

int32_t notecardEnvGetInt(const char* name, int32_t defaultValue) {
    char buffer[32];
    if (!notecardEnvGet(name, buffer, sizeof(buffer))) {
        return defaultValue;
    }
    return atoi(buffer);
}

float notecardEnvGetFloat(const char* name, float defaultValue) {
    char buffer[32];
    if (!notecardEnvGet(name, buffer, sizeof(buffer))) {
        return defaultValue;
    }
    return atof(buffer);
}

bool notecardEnvGetBool(const char* name, bool defaultValue) {
    char buffer[16];
    if (!notecardEnvGet(name, buffer, sizeof(buffer))) {
        return defaultValue;
    }
    return (strcmp(buffer, "true") == 0 || strcmp(buffer, "1") == 0);
}

bool notecardEnvModified(void) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("env.modified");
    J* rsp = s_notecard.requestAndResponse(req);

    if (rsp == NULL) {
        return false;
    }

    uint32_t modCount = JGetInt(rsp, "time");
    s_notecard.deleteResponse(rsp);

    if (modCount != s_lastEnvModCount) {
        s_lastEnvModCount = modCount;
        return true;
    }

    return false;
}

// =============================================================================
// Sleep/Wake
// =============================================================================

bool notecardConfigureSleep(uint32_t sleepSeconds,
                            bool wakeOnMotion,
                            bool wakeOnCommand,
                            const uint8_t* payload,
                            size_t payloadSize) {
    if (!s_initialized) {
        return false;
    }

    J* req = s_notecard.newRequest("card.attn");

    // Build mode string
    String mode = "sleep";
    if (wakeOnMotion) {
        mode += ",motion";
    }
    if (wakeOnCommand) {
        mode += ",files";
    }
    JAddStringToObject(req, "mode", mode.c_str());

    // Add files to watch for command wake
    if (wakeOnCommand) {
        static const char* commandFiles[] = {NOTEFILE_COMMAND};
        J* files = JCreateStringArray(commandFiles, 1);
        JAddItemToObject(req, "files", files);
    }

    // Set sleep duration
    if (sleepSeconds > 0) {
        JAddNumberToObject(req, "seconds", sleepSeconds);
    }

    // Add payload if provided
    if (payload != NULL && payloadSize > 0) {
        // Base64 encode the payload
        // Note: For simplicity, we'd use a proper base64 encoder here
        // The Notecard library may provide this functionality
        JAddStringToObject(req, "payload", (const char*)payload);
    }

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);
    return true;
}

void notecardEnterSleep(void) {
    // The card.attn request with sleep mode will cause the Notecard
    // to pull ATTN low, which (via Notecarrier-F DIP switch) cuts power
    // to the host MCU. No further code executes after this point.

    // Give Notecard a moment to process
    delay(100);

    // If we're still running, something went wrong
    #ifdef DEBUG_MODE
    DEBUG_SERIAL.println("[Notecard] Sleep failed - still running");
    #endif
}

void notecardGetWakeReason(bool* timer, bool* motion, bool* command) {
    // After wake, check what caused the wake
    // This information is available from the Notecard

    if (timer) *timer = false;
    if (motion) *motion = false;
    if (command) *command = false;

    // The wake reason would typically be determined by checking
    // various Notecard states. For now, assume timer wake if nothing else.
    if (timer) *timer = true;
}

size_t notecardGetSleepPayload(uint8_t* buffer, size_t bufferSize) {
    // Retrieve payload saved before sleep
    // This would come from card.attn response after wake

    // For now, return 0 indicating no payload
    return 0;
}

// =============================================================================
// Error Handling
// =============================================================================

uint32_t notecardGetErrorCount(void) {
    return s_errorCount;
}

void notecardResetErrorCount(void) {
    s_errorCount = 0;
}

// =============================================================================
// Outboard DFU (ODFU) Support
// =============================================================================

size_t notecardBuildVersionString(char* buffer, size_t bufferSize) {
    if (buffer == NULL || bufferSize == 0) {
        return 0;
    }

    // Parse version string into major.minor.patch
    int verMajor = 0, verMinor = 0, verPatch = 0;
    sscanf(FIRMWARE_VERSION, "%d.%d.%d", &verMajor, &verMinor, &verPatch);

    // Build JSON version object
    int len = snprintf(buffer, bufferSize,
        "{"
        "\"org\":\"%s\","
        "\"product\":\"%s\","
        "\"description\":\"%s\","
        "\"version\":\"%s\","
        "\"ver_major\":%d,"
        "\"ver_minor\":%d,"
        "\"ver_patch\":%d,"
        "\"built\":\"%s\","
        "\"builder\":\"platformio\""
        "}",
        FIRMWARE_ORG,
        FIRMWARE_PRODUCT,
        FIRMWARE_DESCRIPTION,
        FIRMWARE_VERSION,
        verMajor,
        verMinor,
        verPatch,
        BUILD_TIMESTAMP
    );

    if (len < 0 || (size_t)len >= bufferSize) {
        return 0;
    }

    return (size_t)len;
}

bool notecardReportFirmwareVersion(void) {
    if (!s_initialized) {
        return false;
    }

    // Build version string
    char versionJson[256];
    size_t len = notecardBuildVersionString(versionJson, sizeof(versionJson));
    if (len == 0) {
        NC_ERROR();
        return false;
    }

    // Send dfu.status to report version to Notehub
    J* req = s_notecard.newRequest("dfu.status");
    JAddBoolToObject(req, "on", true);
    JAddStringToObject(req, "version", versionJson);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] dfu.status failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] Firmware version reported: ");
    DEBUG_SERIAL.println(FIRMWARE_VERSION);
    #endif

    return true;
}

bool notecardEnableODFU(void) {
    if (!s_initialized) {
        return false;
    }

    // Enable Outboard DFU for STM32 target
    // This tells the Notecard to use the STM32 ROM bootloader for updates
    J* req = s_notecard.newRequest("card.dfu");
    JAddStringToObject(req, "name", DFU_TARGET);
    JAddStringToObject(req, "mode", DFU_MODE);
    JAddBoolToObject(req, "on", true);

    J* rsp = s_notecard.requestAndResponse(req);
    if (rsp == NULL || s_notecard.responseError(rsp)) {
        #ifdef DEBUG_MODE
        DEBUG_SERIAL.println("[Notecard] card.dfu failed");
        #endif
        if (rsp) s_notecard.deleteResponse(rsp);
        NC_ERROR();
        return false;
    }

    s_notecard.deleteResponse(rsp);

    #ifdef DEBUG_MODE
    DEBUG_SERIAL.print("[Notecard] ODFU enabled for target: ");
    DEBUG_SERIAL.print(DFU_TARGET);
    DEBUG_SERIAL.print(" mode: ");
    DEBUG_SERIAL.println(DFU_MODE);
    #endif

    return true;
}
