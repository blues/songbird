/**
 * @file STM32FreeRTOSConfig_extra.h
 * @brief Project additions to the STM32duino FreeRTOS default configuration
 *
 * The STM32duino FreeRTOS library includes this file, if it can find it,
 * ahead of its own FreeRTOSConfig_Default.h. Everything here is conditional
 * on the Rev A low-power build, so the Cygnet build gets the library's
 * defaults unchanged.
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#ifndef SONGBIRD_FREERTOS_CONFIG_EXTRA_H
#define SONGBIRD_FREERTOS_CONFIG_EXTRA_H

#if defined(SONGBIRD_REVA) && defined(SONGBIRD_IDLE_STOP2) && (SONGBIRD_IDLE_STOP2 == 1)

// Let the idle task suppress the tick and sleep. The sleep itself is
// vPortSuppressTicksAndSleep() in SongbirdLowPower.cpp, which replaces the
// port's weak SysTick-based version with one that enters Stop 2.
#define configUSE_TICKLESS_IDLE     1

// The idle task now re-runs SystemClock_Config() after each Stop 2 wake, and
// the HAL clock structures alone are several hundred bytes. The library
// default (a quarter of the linker's minimum stack, about 128 words) is too
// small for that. Value is in words.
#define configMINIMAL_STACK_SIZE    ((uint16_t)768)

#endif

#endif // SONGBIRD_FREERTOS_CONFIG_EXTRA_H
