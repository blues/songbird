/**
 * @file native_stubs.h
 * @brief Hardware stubs for native (host) test compilation
 *
 * Provides minimal Arduino and FreeRTOS type/function stubs
 * so that pure-logic firmware code can compile and run on the host.
 */

#ifndef NATIVE_STUBS_H
#define NATIVE_STUBS_H

#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <ctype.h>

// =============================================================================
// Arduino Stubs
// =============================================================================

#ifndef HIGH
#define HIGH 1
#endif
#ifndef LOW
#define LOW 0
#endif
#ifndef LED_BUILTIN
#define LED_BUILTIN 13
#endif

// Pin definitions for Cygnet
#ifndef PB9
#define PB9 25
#endif
#ifndef PB13
#define PB13 29
#endif
#ifndef USER_BTN
#define USER_BTN 13
#endif
#ifndef PIN_VCP_RX
#define PIN_VCP_RX 0
#endif
#ifndef PIN_VCP_TX
#define PIN_VCP_TX 1
#endif

// Simulated millis counter for tests
#ifdef __cplusplus
extern "C" {
#endif

static uint32_t _mock_millis = 0;

static inline uint32_t millis(void) {
    return _mock_millis;
}

static inline void mock_set_millis(uint32_t ms) {
    _mock_millis = ms;
}

static inline void digitalWrite(uint8_t pin, uint8_t val) {
    (void)pin;
    (void)val;
}

static inline void pinMode(uint8_t pin, uint8_t mode) {
    (void)pin;
    (void)mode;
}

#ifdef __cplusplus
}
#endif

// Arduino.h compat
#ifndef Arduino_h
#define Arduino_h
#endif

// HardwareSerial stub
#ifdef __cplusplus
class HardwareSerial {
public:
    HardwareSerial() {}
    HardwareSerial(int rx, int tx) { (void)rx; (void)tx; }
    void begin(unsigned long baud) { (void)baud; }
    void print(const char* s) { (void)s; }
    void print(int v) { (void)v; }
    void print(float v, int dec = 2) { (void)v; (void)dec; }
    void print(unsigned long v) { (void)v; }
    void println(const char* s) { (void)s; }
    void println(int v) { (void)v; }
    void println(unsigned long v) { (void)v; }
    void println() {}
};

// Global serial instance (matches firmware's extern declaration)
static HardwareSerial serialDebug;
#define DEBUG_SERIAL serialDebug
#endif

#endif // NATIVE_STUBS_H
