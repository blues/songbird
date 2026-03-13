---
planStatus:
  planId: plan-brownout-detection-safe-shutdown
  title: STM32 Brownout Detection & Safe Shutdown
  status: in-review
  planType: feature
  priority: high
  owner: satch
  stakeholders: []
  tags:
    - firmware
    - power-management
    - stm32
    - reliability
  created: "2026-03-13"
  updated: "2026-03-13T00:00:00.000Z"
  progress: 100
---
# STM32 Brownout Detection & Safe Shutdown

## Implementation Progress

- [x] Phase 1: Add boot cause detection (read RCC->CSR, store reason in state)
- [x] Phase 1: Update SongbirdState with new fields (lastBootTimestamp, consecutiveBrownouts, lastShutdownReason)
- [x] Phase 1: Log brownout boot to health.qo
- [x] Phase 2: Boot-loop prevention logic in setup()
- [x] Phase 3: Create SongbirdPower.h/cpp with PVD init and ISR
- [x] Phase 3: Add g_pvdShutdownRequested flag to SongbirdSync
- [x] Phase 4: Implement pvdSafeShutdown() in MainTask
- [x] Phase 4: Add notecardSendShutdownNote() to SongbirdNotecard

## Problem

When the Songbird battery drains to critically low voltage, the STM32L433 enters a brownout condition and boot-loops. This happens because:

1. The MCU attempts to boot but voltage is insufficient to sustain full operation
2. Flash writes and I2C transactions become unreliable at low voltage
3. The Notecard may fail to respond, causing init retries and longer boot time
4. Each boot attempt drains the already-depleted battery further
5. No persistent record of the shutdown event is captured

This creates a poor user experience and risks data loss. A sales demo device found dead in a boot-loop is a bad demo story.

## Goals

- Detect impending brownout **before** hardware reset occurs (early warning via PVD)
- Perform a safe, coordinated shutdown when voltage drops critically low
- Persist state before power loss so warm boot can resume correctly
- Log the brownout event to Notehub for fleet visibility
- Detect boot-loop conditions and enter a low-power wait state
- Optionally play an audio warning before voltage becomes too low for the buzzer

## Non-Goals

- Changing the BOR (Brown-Out Reset) hardware threshold via option bytes (acceptable as-is)
- Battery fuel gauge or coulomb counting (no hardware support)
- USB-powered operation changes

---

## Background: STM32L433 Power Supervision Hardware

### BOR (Brown-Out Reset)

- **Always active** on STM32L433 — cannot be disabled
- Generates a hardware reset when VDD falls below threshold
- 5 programmable levels via Flash Option Bytes:
  | Level | Voltage |
  |-------|---------|
  | BOR0  | ~1.7V   |
  | BOR1  | ~2.0V   |
  | BOR2  | ~2.2V   |
  | BOR3  | ~2.5V   |
  | BOR4  | ~2.8V   |
- Default level (out of factory) is typically BOR1 (~2.0V) for STM32L4
- Flash requires ≥2.7V for reliable operation — BOR level should be set appropriately
- On reset, `RCC->CSR` bit `BORRSTF` is set; detectable at startup

### PVD (Programmable Voltage Detector)

- **Optional** software-controlled early-warning monitor
- Generates an interrupt (via EXTI line 16) before voltage drops to BOR threshold
- 8 selectable levels from ~2.0V to ~2.9V
- Interrupt fires on rising and/or falling edge
- Enabled via `HAL_PWR_EnablePVD()` / `HAL_PWR_ConfigPVD()`
- Interrupt vector: `PVD_PVM_IRQn`
- Key HAL types: `PWR_PVDTypeDef`, fields: `PVDLevel`, `Mode`

### Reset Cause Detection

Reading `RCC->CSR` at startup reveals why the MCU reset:
- `RCC_CSR_BORRSTF` — brownout occurred
- `RCC_CSR_PINRSTF` — external pin reset
- `RCC_CSR_IWDGRSTF` — watchdog reset
- `RCC_CSR_SFTRSTF` — software reset
- Clear flags with `RCC->CSR |= RCC_CSR_RMVF`

---

## Design

### Two-Layer Defense

```
VDD dropping
     │
     ▼
[PVD threshold ~2.9V]      ← Early warning interrupt fires
     │                         Safe shutdown sequence starts
     │                         (flush notes, save state, sleep)
     │
     ▼
[BOR threshold ~2.0–2.2V]  ← Hardware reset (last resort)
     │
     ▼
[Boot loop prevention]     ← Detect BORRSTF + rapid boots,
                              enter low-power wait
```

### PVD Threshold Selection

The Notecard and I2C peripherals require ~2.7–3.0V for reliable operation. We want PVD to fire while there is still enough voltage to:
1. Complete any in-flight I2C transactions
2. Send a final note to Notehub
3. Save state to Notecard payload
4. Put Notecard to sleep

**STM32L4 PVD levels (confirmed from ****`stm32l4xx_hal_pwr.h`**** and RM0394):**

| Constant | Threshold |
| --- | --- |
| PWR_PVDLEVEL_0 | ~2.0V |
| PWR_PVDLEVEL_1 | ~2.2V |
| PWR_PVDLEVEL_2 | ~2.4V |
| PWR_PVDLEVEL_3 | ~2.5V |
| PWR_PVDLEVEL_4 | ~2.6V |
| PWR_PVDLEVEL_5 | ~2.8V |
| PWR_PVDLEVEL_6 | ~2.9V |
| PWR_PVDLEVEL_7 | External VREFINT |

**Proposed PVD level: ****`PWR_PVDLEVEL_6`**** (\~2.9V)** — the highest fixed threshold available.

Note that 2.9V is lower than the Notecard's ideal operating voltage (~3.0V+). This means the shutdown sequence must be short and conservative — no retries, strict timeouts. The window between PVD firing and BOR (at ~2.0V) is meaningful but voltage drops can be fast under load. The safe shutdown sequence must complete within a few seconds.

### Boot-Loop Detection

On every cold boot, read `RCC->CSR` before clearing flags:
- If `BORRSTF` is set → log brownout as boot cause
- Track rapid successive boots using state's `bootCount` + a new `lastBootTimestamp` in `SongbirdState`
- If `bootCount` increments faster than a threshold (e.g., 3 boots in < 30 seconds), enter a **low-power hold** state:
  1. Send a single `alert.qo` brownout boot-loop alert (one attempt, no retry) before suspending tasks
  2. Suspend all tasks, put Notecard to sleep
  3. Delay 60 seconds in low-power mode to allow charger/battery to recover voltage
  4. Reset `consecutiveBrownouts` counter before resuming

### Safe Shutdown Sequence (PVD ISR → Handler)

When the PVD interrupt fires (voltage crossing threshold going down):

1. **Set a global atomic flag** `g_pvdShutdownRequested` (from ISR context — no blocking calls)
2. **MainTask detects the flag** in its main loop (high priority check, before button/config processing)
3. MainTask executes coordinated safe shutdown:
   a. Play a single low-battery warning tone (buzzer should still be reliable at 2.9V)
   b. Cancel any active locate sequences
   c. Suspend sensor reads (stop queuing new notes)
   d. Drain the note queue — attempt to send any pending notes (up to `PVD_QUEUE_DRAIN_LIMIT`, with `PVD_SHUTDOWN_NOTE_TIMEOUT` deadline)
   e. Send a `health.qo` note with `{"shutdown": "pvd_low_battery", "voltage": <v>}`
   f. Call `stateSave()` to persist state
   g. Call `notecardEnterSleep()`
   h. STM32 enters `STOP2` low-power mode (deepest sleep retaining SRAM)

### New Files

```
src/
└── core/
    ├── SongbirdPower.h     # Power monitoring interface
    └── SongbirdPower.cpp   # PVD init, ISR, boot cause detection
```

### Changes to Existing Files

| File | Change |
| --- | --- |
| `platformio.ini` | Add `-D HAL_PWR_EX_MODULE_ENABLED` if needed for extended PWR |
| `SongbirdConfig.h` | Add `PVDLEVEL_SHUTDOWN` constant, `BOOT_LOOP_MAX_COUNT`, `BOOT_LOOP_WINDOW_MS` |
| `SongbirdState.h/cpp` | Add `lastBootTimestamp`, `consecutiveBrownouts`, `lastShutdownReason` to `SongbirdState` struct; update `STATE_VERSION` to 5 |
| `main.cpp` | Call `powerInit()` early in `setup()` before FreeRTOS starts; read and log boot cause |
| `SongbirdTasks.cpp` (MainTask) | Check `g_pvdShutdownRequested` at top of loop; implement `pvdSafeShutdown()` |
| `SongbirdNotecard.h/cpp` | Add `notecardSendShutdownNote(float voltage, const char* reason)` |
| `SongbirdSync.h/cpp` | Add `g_pvdShutdownRequested` volatile atomic flag |

---

## Implementation Steps

### Phase 1: Boot Cause Detection & Logging
1. Read `RCC->CSR` reset flags in `setup()` before clearing
2. Store boot cause in `SongbirdState` (`lastShutdownReason`)
3. Log to `health.qo` if brownout detected
4. Clear flags with `RCC_CSR_RMVF`

### Phase 2: Boot-Loop Prevention
1. Add `lastBootTimestamp` and `consecutiveBrownouts` to state
2. In `setup()`, detect rapid boot pattern
3. If threshold exceeded, enter low-power hold:
  - Suspend FreeRTOS task creation
  - Delay 60s in low-power mode
  - Reset `consecutiveBrownouts` counter

### Phase 3: PVD Early Warning
1. Create `SongbirdPower.h/cpp`
2. `powerInit()`: Configure PVD level + mode, enable NVIC, call `HAL_PWR_EnablePVD()`
3. Implement `PVD_PVM_IRQHandler()` → `HAL_PWR_PVD_IRQHandler()` → `HAL_PWR_PVDCallback()`
4. In callback: set `g_pvdShutdownRequested = true`
5. Add `g_pvdShutdownRequested` check in MainTask loop

### Phase 4: Safe Shutdown Handler
1. Implement `pvdSafeShutdown()` in MainTask context
2. Short-circuit note queue: drain up to N pending items with timeout
3. Send shutdown health note
4. Save state, enter Notecard sleep
5. Enter STM32 STOP2 via `HAL_PWREx_EnterSTOP2Mode()`

### Phase 5: Testing & Tuning
1. Test PVD threshold calibration at bench (power supply with current limiting)
2. Test boot-loop prevention
3. Test warm boot after PVD shutdown (state restoration)
4. Verify health note appears in Notehub

---

## Configuration Constants (proposed additions to SongbirdConfig.h)

```c
// PVD threshold for safe shutdown early warning
// PWR_PVDLEVEL_6 = ~2.9V on STM32L4 (confirmed, highest fixed threshold)
#define PVD_SHUTDOWN_LEVEL          PWR_PVDLEVEL_6

// Boot-loop prevention
#define BOOT_LOOP_MAX_COUNT         3       // Max consecutive brownout boots
#define BOOT_LOOP_WINDOW_SEC        30      // Window to detect boot loop (seconds)
#define BOOT_LOOP_HOLD_SEC          60      // How long to wait before retrying

// Safe shutdown
#define PVD_SHUTDOWN_NOTE_TIMEOUT   5000    // ms to attempt final note send
#define PVD_QUEUE_DRAIN_LIMIT       3       // Max queued notes to flush before shutdown
```

---

## Risk & Considerations

| Risk | Mitigation |
| --- | --- |
| PVD fires too early (too much voltage headroom wasted) | Tune threshold; use hysteresis mode |
| Not enough time to complete I2C transactions before BOR | Keep shutdown sequence minimal; set strict timeouts |
| ISR fires during existing I2C transaction | ISR only sets flag; all I2C work happens in task context |
| State version mismatch after adding new fields | Increment `STATE_VERSION` to 5; existing warm boots will fail checksum → cold boot (acceptable) |
| Voltage drops faster than shutdown completes | Keep sequence to ≤3s total; abort non-critical steps early if voltage keeps falling |
| `HAL_PWR_PVDCallback` conflicts with Arduino HAL | May need `__weak` override; verify linkage in stm32duino framework |

---

## Resolved Decisions

1. **PVD levels confirmed:** STM32L433 supports `PWR_PVDLEVEL_0` (~2.0V) through `PWR_PVDLEVEL_6` (~2.9V) as fixed thresholds; `PWR_PVDLEVEL_7` is external VREFINT. We use `PWR_PVDLEVEL_6` (~2.9V).

2. **BOR option byte:** Yes — raise BOR level to `OB_BOR_LEVEL_4` (~2.8V) to ensure a meaningful gap above deep discharge and improve Flash write reliability. **Important caveat:** Option bytes cannot be updated via OTA (ODFU). The Notecard DFU mechanism only updates application firmware, not Flash option bytes. The BOR change requires physical ST-Link access and applies only to devices re-flashed at the bench. Field devices will retain their existing BOR level. The PVD-based safe shutdown (implemented in firmware) is what provides protection for all devices including those already deployed.

3. **Boot-loop hold alert:** Send a single `alert.qo` note before entering the hold state, then conserve power. One alert is enough for fleet visibility; do not retry.

4. **Audio warning:** Play a single short low-battery tone at the start of the PVD safe shutdown sequence. The buzzer should be operational at 2.9V (Qwiic Buzzer I2C minimum is well below this). Only one playback — do not loop.

---

## References

- STM32L4 Reference Manual RM0394 — Section 5 (Power Control), Table 48 (PVD levels)
- [`stm32l4xx_hal_pwr.h`](https://github.com/STMicroelectronics/STM32CubeL4/blob/master/Drivers/STM32L4xx_HAL_Driver/Inc/stm32l4xx_hal_pwr.h)
- [STM32L4 System Power Training](https://www.st.com/resource/en/product_training/stm32l4_system_power.pdf)
- [PVD interrupt configuration — STM32 Community](https://community.st.com/t5/stm32-mcus-products/how-to-get-pvd-programmable-voltage-detector-interrupt-working/td-p/463714)
- [BOR level configuration via option bytes](https://www.beyondlogic.org/using-stm32-hal-with-zephyr-setting-the-brown-out-reset-threshold/)
