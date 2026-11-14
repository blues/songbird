/**
 * @file bringup_main.cpp
 * @brief Songbird Rev A bring-up firmware.
 *
 * A small console-driven test image for the first power-up of a Rev A board.
 * It follows songbird-pcb/docs/bringup/CHECKLIST.md section 4 onward and is
 * deliberately separate from the application: nothing here depends on the
 * Songbird task architecture.
 *
 * Console: STLINK virtual COM port, 115200 8N1. Send 'h' for help.
 * Build:   pio run -e reva_bringup            (bare loop)
 *          pio run -e reva_bringup_rtos       (same tests under FreeRTOS)
 *
 * Copyright (c) 2026 Blues Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

#include <Arduino.h>
#include <Wire.h>
#include <Notecard.h>
#include "SongbirdBoardRevA.h"

#ifdef BRINGUP_RTOS
#include <STM32FreeRTOS.h>
#endif

HardwareSerial console(BOARD_CONSOLE_RX_PIN, BOARD_CONSOLE_TX_PIN);
static Notecard notecard;
static bool notecardStarted = false;

static volatile uint32_t buttonEdges = 0;
static volatile uint32_t attnEdges = 0;
static bool chargeInhibited = false;
static bool manualColour = false;   // heartbeat pauses while a colour is set by hand

// -----------------------------------------------------------------------------
// LEDs (all active low)
// -----------------------------------------------------------------------------

static void ld1Set(uint8_t r, uint8_t g, uint8_t b) {
    analogWrite(BOARD_LED_RED_PIN, 255 - r);
    analogWrite(BOARD_LED_GREEN_PIN, 255 - g);
    analogWrite(BOARD_LED_BLUE_PIN, 255 - b);
}

static void btnLedSet(bool red, bool green) {
    digitalWrite(BOARD_BTN_LED_RED_PIN, red ? BOARD_LED_ON : BOARD_LED_OFF);
    digitalWrite(BOARD_BTN_LED_GREEN_PIN, green ? BOARD_LED_ON : BOARD_LED_OFF);
}

// -----------------------------------------------------------------------------
// Buzzer
// -----------------------------------------------------------------------------

static void buzzerChirp(void) {
    tone(BOARD_BUZZER_PIN, 2700, 120);
    delay(160);
    tone(BOARD_BUZZER_PIN, 3200, 120);
    delay(160);
    noTone(BOARD_BUZZER_PIN);
    // Q1 must be left off, or LS1 draws continuous current.
    pinMode(BOARD_BUZZER_PIN, OUTPUT);
    digitalWrite(BOARD_BUZZER_PIN, LOW);
}

// -----------------------------------------------------------------------------
// I2C helpers
// -----------------------------------------------------------------------------

static bool i2cProbe(uint8_t addr) {
    Wire.beginTransmission(addr);
    return Wire.endTransmission() == 0;
}

static int i2cReadReg(uint8_t addr, uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) {
        return -1;
    }
    if (Wire.requestFrom(addr, (uint8_t)1) != 1) {
        return -1;
    }
    return Wire.read();
}

static void i2cScan(void) {
    console.println("[i2c] scan:");
    uint8_t found = 0;
    for (uint8_t addr = 0x08; addr < 0x78; addr++) {
        if (i2cProbe(addr)) {
            found++;
            console.print("  0x");
            console.print(addr, HEX);
            if (addr == BOARD_NOTECARD_ADDR) console.print("  Notecard");
            if (addr == BOARD_CHARGER_ADDR)  console.print("  BQ25628");
            if (addr == BOARD_BME280_ADDR)   console.print("  BME280");
            console.println();
        }
    }
    console.print("[i2c] ");
    console.print(found);
    console.println(" device(s). Expect 0x6A and 0x77, plus 0x17 with a Notecard fitted.");

    int id = i2cReadReg(BOARD_BME280_ADDR, 0xD0);
    console.print("[bme280] chip id 0x");
    console.print(id, HEX);
    console.println(id == 0x60 ? "  OK" : "  (expected 0x60)");

    int part = i2cReadReg(BOARD_CHARGER_ADDR, 0x38);
    console.print("[bq25628] part information (reg 0x38): ");
    if (part < 0) {
        console.println("no answer");
    } else {
        console.print("0x");
        console.println(part, HEX);
    }
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

static void printStatus(void) {
    console.println("[status]");
    console.print("  device id      0x");
    console.print(HAL_GetDEVID(), HEX);
    console.println("  (expect 0x482)");
    console.print("  sysclk         ");
    console.print(HAL_RCC_GetSysClockFreq());
    console.println(" Hz");
    console.print("  nSWBOOT0       ");
    console.println((FLASH->OPTR & FLASH_OPTR_nSWBOOT0) ? "1  OK (BOOT0 pin selects boot)"
                                                         : "0  WRONG: outboard DFU will fail; set the option bit");
    console.print("  button (PC13)  ");
    console.print(digitalRead(BOARD_BUTTON_PIN) == BOARD_BUTTON_ACTIVE ? "pressed" : "released");
    console.print(", edges ");
    console.println(buttonEdges);
    console.print("  ATTN (PB7)     ");
    console.print(digitalRead(BOARD_ATTN_PIN));
    console.print(", rising edges ");
    console.println(attnEdges);
    console.print("  DFU_ACTIVE     ");
    console.println(digitalRead(BOARD_DFU_ACTIVE_PIN));
    console.print("  CHG_STAT (PB8) ");
    console.println(digitalRead(BOARD_CHG_STAT_PIN) ? "high (not charging / no battery)" : "low (charging)");
    console.print("  CHG_CE (PA15)  ");
    console.println(chargeInhibited ? "driven high (charging inhibited)" : "input (charging enabled by R23)");
}

static void printHelp(void) {
    console.println("Songbird Rev A bring-up. Commands:");
    console.println("  h  this help            s  status");
    console.println("  i  I2C scan + chip IDs  z  buzzer chirp");
    console.println("  r g b  LD1 red / green / blue      w  LD1 white      o  LD1 off");
    console.println("  1  SW1 red LED   2  SW1 green LED   0  SW1 LEDs off");
    console.println("  c  toggle charge inhibit (CHG_CE)");
    console.println("  n  Notecard card.version");
    console.println("  {...}  any line starting with { is sent to the Notecard as a request");
}

// -----------------------------------------------------------------------------
// Notecard passthrough
// -----------------------------------------------------------------------------

static void notecardRequest(const char *json) {
    if (!i2cProbe(BOARD_NOTECARD_ADDR)) {
        console.println("[notecard] no answer at 0x17 (not fitted?)");
        return;
    }
    if (!notecardStarted) {
        notecard.begin();
        notecardStarted = true;
    }
    J *req = JParse(json);
    if (req == NULL) {
        console.println("[notecard] could not parse that as JSON");
        return;
    }
    J *rsp = notecard.requestAndResponse(req);
    if (rsp == NULL) {
        console.println("[notecard] no response");
        return;
    }
    char *text = JPrintUnformatted(rsp);
    if (text != NULL) {
        console.println(text);
        JFree(text);
    }
    notecard.deleteResponse(rsp);
}

// -----------------------------------------------------------------------------
// Console
// -----------------------------------------------------------------------------

static char lineBuf[512];
static size_t lineLen = 0;
static bool inJson = false;

static void handleChar(char c) {
    if (inJson) {
        if (c == '\r' || c == '\n') {
            lineBuf[lineLen] = '\0';
            notecardRequest(lineBuf);
            lineLen = 0;
            inJson = false;
        } else if (lineLen < sizeof(lineBuf) - 1) {
            lineBuf[lineLen++] = c;
        }
        return;
    }
    switch (c) {
        case '{': inJson = true; lineLen = 0; lineBuf[lineLen++] = c; break;
        case 'h': case '?': printHelp(); break;
        case 's': printStatus(); break;
        case 'i': i2cScan(); break;
        case 'z': console.println("[buzzer] chirp"); buzzerChirp(); break;
        case 'r': console.println("[ld1] red"); manualColour = true; ld1Set(255, 0, 0); break;
        case 'g': console.println("[ld1] green"); manualColour = true; ld1Set(0, 255, 0); break;
        case 'b': console.println("[ld1] blue"); manualColour = true; ld1Set(0, 0, 255); break;
        case 'w': console.println("[ld1] white"); manualColour = true; ld1Set(255, 255, 255); break;
        case 'o': console.println("[ld1] off, heartbeat resumes"); manualColour = false; ld1Set(0, 0, 0); break;
        case '1': console.println("[sw1] red LED");   btnLedSet(true, false); break;
        case '2': console.println("[sw1] green LED"); btnLedSet(false, true); break;
        case '0': console.println("[sw1] LEDs off");  btnLedSet(false, false); break;
        case 'c':
            chargeInhibited = !chargeInhibited;
            if (chargeInhibited) {
                pinMode(BOARD_CHG_CE_PIN, OUTPUT);
                digitalWrite(BOARD_CHG_CE_PIN, HIGH);
            } else {
                pinMode(BOARD_CHG_CE_PIN, INPUT);
            }
            console.println(chargeInhibited ? "[chg] inhibited" : "[chg] enabled");
            break;
        case 'n': notecardRequest("{\"req\":\"card.version\"}"); break;
        default: break;
    }
}

static void buttonIsr(void) { buttonEdges++; }
static void attnIsr(void)   { attnEdges++; }

// -----------------------------------------------------------------------------
// Main work, shared by the bare-loop and FreeRTOS builds
// -----------------------------------------------------------------------------

static void boardInit(void) {
    boardRevAKeepTickAlive();   // see SongbirdBoardRevA.h; matters for the FreeRTOS build

    // Buzzer gate low before anything else.
    pinMode(BOARD_BUZZER_PIN, OUTPUT);
    digitalWrite(BOARD_BUZZER_PIN, LOW);

    pinMode(BOARD_BTN_LED_RED_PIN, OUTPUT);
    pinMode(BOARD_BTN_LED_GREEN_PIN, OUTPUT);
    btnLedSet(false, false);
    ld1Set(0, 0, 0);

    pinMode(BOARD_BUTTON_PIN, INPUT);           // external pull-up R42
    pinMode(BOARD_ATTN_PIN, INPUT_PULLDOWN);
    pinMode(BOARD_DFU_ACTIVE_PIN, INPUT);
    pinMode(BOARD_CHG_STAT_PIN, INPUT_PULLUP);  // open-drain STAT
    pinMode(BOARD_CHG_CE_PIN, INPUT);           // R23 enables charging

    attachInterrupt(digitalPinToInterrupt(BOARD_BUTTON_PIN), buttonIsr, CHANGE);
    attachInterrupt(digitalPinToInterrupt(BOARD_ATTN_PIN), attnIsr, RISING);

    console.begin(BOARD_CONSOLE_BAUD);
    boardRevAConsoleSwap();     // erratum E4: TX and RX are crossed at J5
    Wire.setSDA(BOARD_I2C_SDA_PIN);
    Wire.setSCL(BOARD_I2C_SCL_PIN);
    Wire.begin();
    Wire.setClock(100000);

    console.println();
    console.println("========================================");
    console.println("  Songbird Rev A bring-up");
#ifdef BRINGUP_RTOS
    console.println("  build: FreeRTOS");
#else
    console.println("  build: bare loop");
#endif
    console.println("========================================");
    printStatus();
    i2cScan();
    printHelp();
}

static void heartbeatStep(void) {
    // Dim red blink on LD1 unless the user has set a colour by hand.
    static uint32_t last = 0;
    static bool on = false;
    static uint32_t lastEdges = 0;
    uint32_t now = millis();
    if (!manualColour && now - last >= 500) {
        last = now;
        on = !on;
        analogWrite(BOARD_LED_RED_PIN, on ? 255 - 24 : 255);
    }
    if (buttonEdges != lastEdges) {
        lastEdges = buttonEdges;
        console.print("[button] ");
        console.print(digitalRead(BOARD_BUTTON_PIN) == BOARD_BUTTON_ACTIVE ? "pressed" : "released");
        console.print(", edges ");
        console.println(lastEdges);
    }
}

#ifdef BRINGUP_RTOS

static void consoleTask(void *arg) {
    (void)arg;
    for (;;) {
        while (console.available() > 0) {
            handleChar((char)console.read());
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void heartbeatTask(void *arg) {
    (void)arg;
    for (;;) {
        heartbeatStep();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void setup() {
    boardInit();
    xTaskCreate(consoleTask, "console", 1024, NULL, 2, NULL);
    xTaskCreate(heartbeatTask, "beat", 256, NULL, 1, NULL);
    console.println("[rtos] starting scheduler");
    vTaskStartScheduler();
    console.println("[rtos] ERROR: scheduler returned");
    for (;;) { }
}

void loop() { }

#else

void setup() {
    boardInit();
}

void loop() {
    while (console.available() > 0) {
        handleChar((char)console.read());
    }
    heartbeatStep();
    delay(5);
}

#endif
