/**
 * @file SongbirdLowPower.cpp
 * @brief Stop 2 in the FreeRTOS idle path (Songbird Rev A)
 *
 * Songbird - Blues Sales Demo Device
 * Copyright (c) 2025 Blues Inc.
 */

#include "SongbirdLowPower.h"

#ifdef SONGBIRD_LOW_POWER_ENABLED

#include <STM32FreeRTOS.h>
#include "SongbirdConfig.h"

// The variant's clock setup (160 MHz from the MSI through PLL1). Stop 2 leaves
// the system on the bare MSI with the PLL off, so this is re-run on each wake.
extern "C" void SystemClock_Config(void);

// =============================================================================
// Tuning
// =============================================================================

// Shortest idle period worth a Stop 2 entry. Below this the cost of arming
// the timer and relocking the PLL outweighs the saving.
#define LP_MIN_STOP_TICKS       5U

// LPTIM1 is a 16-bit counter running at the LSI rate, 32 counts per
// millisecond, so one run covers about 2 s. Longer idle periods are taken as
// several stops in a row.
//
// The counter is not prescaled down to 1 kHz. Board 1 showed why: register
// writes to LPTIM1 are acknowledged in units of the prescaled clock, so with
// a /32 prescaler arming took 7.5 ms and the count started 4 ms late, every
// time, with the core awake and interrupts held off.
#define LP_COUNTS_PER_TICK      32U
#define LP_MAX_STOP_TICKS       2000U

// No Stop 2 for this long after reset. Guarantees a window in which a debug
// probe can attach to a release build, whatever the application is doing.
#define LP_BOOT_HOLDOFF_MS      15000U

// Timer self-test length, and the tolerance on it. The LSI is specified well
// inside this; a result outside it means the timer is not set up as intended.
#define LP_SELFTEST_TICKS       50U
#define LP_SELFTEST_MIN_MS      40U
#define LP_SELFTEST_MAX_MS      63U

#define LP_LPTIM_CLEAR_ALL      (LPTIM_ICR_ARRMCF | LPTIM_ICR_ARROKCF | LPTIM_ICR_DIEROKCF)

// =============================================================================
// Module State
// =============================================================================

static volatile bool     s_ready = false;           // timer self-test passed
static volatile bool     s_audioActive = false;
static bool              s_holdoffDone = false;
static volatile uint32_t s_stopCount = 0;           // Stop 2 entries
static volatile uint32_t s_stopMs = 0;              // time spent in Stop 2
static volatile uint32_t s_attnEdges = 0;
static uint32_t          s_selfTestMs = 0;

// =============================================================================
// LPTIM1: one-shot wake timer on the LSI
// =============================================================================

// Register writes to LPTIM1 cross into its counter clock domain and take a
// few of that clock's cycles to land. The bound is a loop count because this
// runs with interrupts masked, where millis() does not advance.
static bool lptimWait(uint32_t flag) {
    for (uint32_t i = 0; i < 400000UL; i++) {
        if (LPTIM1->ISR & flag) {
            return true;
        }
    }
    return false;
}

static void lptimDisarm(void) {
    LPTIM1->ICR = LP_LPTIM_CLEAR_ALL;
    LPTIM1->CR = 0;                         // disabling also resets the counter
    NVIC_DisableIRQ(LPTIM1_IRQn);
    NVIC_ClearPendingIRQ(LPTIM1_IRQn);
}

// Start a single count of `ticks` milliseconds ending in an interrupt.
static bool lptimArm(uint32_t ticks) {
    LPTIM1->CR = LPTIM_CR_ENABLE;
    LPTIM1->ICR = LP_LPTIM_CLEAR_ALL;

    // On the U5 the interrupt enable register is written with the timer
    // enabled, and the write is acknowledged by DIEROK.
    LPTIM1->DIER = LPTIM_DIER_ARRMIE;
    if (!lptimWait(LPTIM_ISR_DIEROK)) {
        return false;
    }

    LPTIM1->ARR = ticks * LP_COUNTS_PER_TICK;
    if (!lptimWait(LPTIM_ISR_ARROK)) {
        return false;
    }

    LPTIM1->ICR = LP_LPTIM_CLEAR_ALL;
    NVIC_ClearPendingIRQ(LPTIM1_IRQn);
    NVIC_EnableIRQ(LPTIM1_IRQn);
    LPTIM1->CR = LPTIM_CR_ENABLE | LPTIM_CR_SNGSTRT;
    return true;
}

// How many milliseconds of the armed count have passed.
static uint32_t lptimElapsed(uint32_t ticks) {
    if (LPTIM1->ISR & LPTIM_ISR_ARRM) {
        return ticks;
    }
    // The counter is asynchronous to the bus: read until two reads agree.
    uint32_t a = LPTIM1->CNT;
    for (uint8_t i = 0; i < 8; i++) {
        uint32_t b = LPTIM1->CNT;
        if (a == b) {
            break;
        }
        a = b;
    }
    a = (a & 0xFFFFU) / LP_COUNTS_PER_TICK;
    return (a > ticks) ? ticks : a;
}

// The handler has nothing to do: reaching the interrupt is what wakes the
// core, and the idle path reads the flag itself. Masking the line here stops
// it re-entering until the next lptimArm().
extern "C" void LPTIM1_IRQHandler(void) {
    NVIC_DisableIRQ(LPTIM1_IRQn);
}

static bool lptimInit(void) {
    // LSI on. It lives in the backup domain; the HAL handles the write access.
    RCC_OscInitTypeDef osc = {};
    osc.OscillatorType = RCC_OSCILLATORTYPE_LSI;
    osc.LSIState = RCC_LSI_ON;
    osc.LSIDiv = RCC_LSI_DIV1;
    osc.PLL.PLLState = RCC_PLL_NONE;
    if (HAL_RCC_OscConfig(&osc) != HAL_OK) {
        return false;
    }

    RCC_PeriphCLKInitTypeDef clk = {};
    clk.PeriphClockSelection = RCC_PERIPHCLK_LPTIM1;
    clk.Lptim1ClockSelection = RCC_LPTIM1CLKSOURCE_LSI;
    if (HAL_RCCEx_PeriphCLKConfig(&clk) != HAL_OK) {
        return false;
    }

    __HAL_RCC_LPTIM1_CLK_ENABLE();
    __HAL_RCC_LPTIM1_CLKAM_ENABLE();        // keep it clocked in Stop 0/1/2

    // Internal clock, no prescaler: the counter runs at the 32 kHz LSI rate,
    // LP_COUNTS_PER_TICK counts per RTOS tick.
    LPTIM1->CR = 0;
    LPTIM1->CFGR = 0;

    NVIC_SetPriority(LPTIM1_IRQn, 5);
    return true;
}

// =============================================================================
// Conditions that rule out Stop 2
// =============================================================================

// Debug console (USART2) still shifting bytes out. Stopping the clocks
// mid-character corrupts the line.
static inline bool consoleBusy(void) {
    uint32_t cr1 = USART2->CR1;
    if ((cr1 & USART_CR1_UE) == 0) {
        return false;
    }
    if (cr1 & (USART_CR1_TXEIE | USART_CR1_TCIE)) {
        return true;
    }
    return (USART2->ISR & USART_ISR_TC) == 0;
}

static inline bool stopBlocked(void) {
    if (!s_holdoffDone) {
        if (millis() < LP_BOOT_HOLDOFF_MS) {
            return true;
        }
        s_holdoffDone = true;
    }
    return s_audioActive || consoleBusy();
}

// =============================================================================
// FreeRTOS tickless idle
// =============================================================================

/**
 * Called by the idle task, with the scheduler suspended, when no task is due
 * for at least configEXPECTED_IDLE_TIME_BEFORE_SLEEP ticks. Replaces the weak
 * implementation in the Cortex-M33 port.
 */
extern "C" void vPortSuppressTicksAndSleep(TickType_t xExpectedIdleTime) {
    if (!s_ready || xExpectedIdleTime < LP_MIN_STOP_TICKS || stopBlocked()) {
        // Ordinary sleep with the tick running. The next tick, at most a
        // millisecond away, or any other interrupt ends it.
        __WFI();
        return;
    }

    if (xExpectedIdleTime > LP_MAX_STOP_TICKS) {
        xExpectedIdleTime = LP_MAX_STOP_TICKS;
    }
    // One tick short of the deadline, to leave room for the wake-up itself.
    const uint32_t sleepTicks = (uint32_t)xExpectedIdleTime - 1U;

    // From here interrupts are held pending rather than taken. A pending
    // interrupt still ends the WFI below, and is serviced when interrupts
    // are released at the bottom, after clocks and time are consistent again.
    __disable_irq();
    __DSB();
    __ISB();

    if (eTaskConfirmSleepModeStatus() == eAbortSleep) {
        __enable_irq();
        return;
    }

    if (!lptimArm(sleepTicks)) {
        lptimDisarm();
        s_ready = false;                    // fall back to ordinary sleep for good
        __enable_irq();
        return;
    }

    SysTick->CTRL &= ~SysTick_CTRL_ENABLE_Msk;
    SCB->ICSR = SCB_ICSR_PENDSTCLR_Msk;

    HAL_PWREx_EnterSTOP2Mode(PWR_STOPENTRY_WFI);

    // Stop 2 exits on the MSI with PLL1 off. If the WFI fell straight through
    // on an interrupt that was already pending, the clocks never changed.
    if (__HAL_RCC_GET_SYSCLK_SOURCE() != RCC_SYSCLKSOURCE_STATUS_PLLCLK) {
        SystemClock_Config();
    }

    uint32_t elapsed = lptimElapsed(sleepTicks);
    lptimDisarm();

    // Restart the tick at the kernel's rate and credit the time asleep to
    // both clocks: the RTOS tick count, and the HAL tick behind millis().
    SysTick->LOAD = (SystemCoreClock / configTICK_RATE_HZ) - 1UL;
    SysTick->VAL = 0UL;
    SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk | SysTick_CTRL_ENABLE_Msk;

    vTaskStepTick((TickType_t)elapsed);
    uwTick = uwTick + elapsed;

    s_stopCount++;
    s_stopMs += elapsed;

    __enable_irq();
}

// =============================================================================
// Public Interface
// =============================================================================

static void attnIsr(void) {
    s_attnEdges++;
}

void lowPowerInit(void) {
    __HAL_RCC_PWR_CLK_ENABLE();

    #ifdef DEBUG_MODE
    // Keep the debug port alive in Stop 2 so the probe can attach and flash
    // at any time. This raises Stop 2 current; measure with a release build.
    DBGMCU->CR |= DBGMCU_CR_DBG_STOP;
    #endif

    // ATTN is a wake source. Nothing arms it yet (no card.attn request is
    // sent), so it stays quiet until that is decided; edges are counted.
    attachInterrupt(digitalPinToInterrupt(BOARD_ATTN_PIN), attnIsr, RISING);

    if (!lptimInit()) {
        DEBUG_SERIAL.println("[LowPower] LSI/LPTIM1 setup failed, Stop 2 disabled");
        return;
    }

    // Self-test: time two runs of different length against the CPU clock.
    // The difference between them gives the count rate with the fixed cost
    // of arming and starting the timer cancelled out; the arm time is
    // reported on its own because every Stop 2 entry pays it. This checks
    // the oscillator, clock selection, prescaler and wake flag. It runs in
    // Run mode, so it does not prove the wake from Stop 2 itself.
    uint32_t armUs = 0;
    uint32_t runUs[2] = {0, 0};
    const uint32_t counts[2] = {LP_SELFTEST_TICKS, 4U * LP_SELFTEST_TICKS};
    bool fired = true;
    for (uint8_t n = 0; n < 2; n++) {
        uint32_t t0 = micros();
        bool armed = lptimArm(counts[n]);
        uint32_t t1 = micros();
        while (armed && !(LPTIM1->ISR & LPTIM_ISR_ARRM) &&
               (micros() - t1) < (3000UL * counts[n])) {
        }
        runUs[n] = micros() - t1;
        fired = fired && armed && (LPTIM1->ISR & LPTIM_ISR_ARRM);
        lptimDisarm();
        if (n == 0) {
            armUs = t1 - t0;
        }
    }

    // Microseconds per count, from the difference of the two runs.
    uint32_t usPerCount = (runUs[1] - runUs[0]) / (counts[1] - counts[0]);
    s_selfTestMs = runUs[0] / 1000U;
    s_ready = fired && usPerCount >= 800U && usPerCount <= 1250U;

    DEBUG_SERIAL.print("[LowPower] LPTIM1 self-test: arm ");
    DEBUG_SERIAL.print(armUs);
    DEBUG_SERIAL.print(" us, ");
    DEBUG_SERIAL.print(counts[0]);
    DEBUG_SERIAL.print(" ms run ");
    DEBUG_SERIAL.print(runUs[0]);
    DEBUG_SERIAL.print(" us, ");
    DEBUG_SERIAL.print(counts[1]);
    DEBUG_SERIAL.print(" ms run ");
    DEBUG_SERIAL.print(runUs[1]);
    DEBUG_SERIAL.print(" us, ");
    DEBUG_SERIAL.print(usPerCount);
    DEBUG_SERIAL.println(s_ready ? " us/ms, Stop 2 enabled" : " us/ms, FAILED, Stop 2 disabled");
}

void lowPowerSetAudioActive(bool active) {
    s_audioActive = active;
}

void lowPowerLogStats(void) {
    static uint32_t lastMs = 0;
    static uint32_t lastStopMs = 0;
    static uint32_t lastCount = 0;

    uint32_t now = millis();
    uint32_t stopMs = s_stopMs;
    uint32_t count = s_stopCount;

    uint32_t span = now - lastMs;
    uint32_t stopped = stopMs - lastStopMs;

    DEBUG_SERIAL.print("[LowPower] Stop 2: ");
    DEBUG_SERIAL.print(count - lastCount);
    DEBUG_SERIAL.print(" entries, ");
    DEBUG_SERIAL.print(stopped);
    DEBUG_SERIAL.print(" ms of the last ");
    DEBUG_SERIAL.print(span);
    DEBUG_SERIAL.print(" ms (");
    DEBUG_SERIAL.print(span ? (stopped * 100UL) / span : 0);
    DEBUG_SERIAL.print("%), ATTN edges ");
    DEBUG_SERIAL.print(s_attnEdges);
    DEBUG_SERIAL.println(s_ready ? "" : ", DISABLED");

    lastMs = now;
    lastStopMs = stopMs;
    lastCount = count;
}

#endif // SONGBIRD_LOW_POWER_ENABLED
