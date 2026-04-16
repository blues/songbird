/**
 * @file HardwareSerial.h
 * @brief Shim for native test builds
 *
 * SongbirdConfig.h includes <HardwareSerial.h> inside an __cplusplus guard.
 * This shim satisfies that include using the stubs already defined in
 * native_stubs.h. If native_stubs.h has not been included yet, it provides
 * a minimal HardwareSerial class directly.
 */

#ifndef HARDWARE_SERIAL_H_SHIM
#define HARDWARE_SERIAL_H_SHIM

#ifndef NATIVE_STUBS_H
// Provide a minimal stub if native_stubs.h wasn't included first
#include <stdint.h>

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
#endif

#endif // HARDWARE_SERIAL_H_SHIM
