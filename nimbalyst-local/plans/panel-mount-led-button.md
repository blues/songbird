---
planStatus:
  planId: plan-panel-mount-led-button
  title: Panel Mount LED Button for Transit/Demo Lock
  status: in-development
  planType: feature
  priority: high
  owner: developer
  tags:
    - hardware
    - firmware
    - button
    - led
    - transit-lock
    - demo-lock
  created: "2026-01-19"
  updated: "2026-01-19T22:15:00.000Z"
  progress: 50
---
# Panel Mount LED Button for Transit/Demo Lock

## Goals
- Replace the internal Cygnet user button with a panel-mount LED button for Transit/Demo lock
- Wire the SparkFun Metal Pushbutton (16mm, Green LED) to the STM32L433
- Implement LED control to indicate when Transit or Demo lock is engaged
- Maintain existing click patterns (single=transit, double=demo, triple=mute)

## Overview

The current Songbird device uses the internal user button on the Notecarrier CX (Cygnet) for Transit and Demo lock control. This plan replaces that with an external panel-mount button with integrated LED for better accessibility and visual feedback.

**Button**: [SparkFun Metal Pushbutton Momentary 16mm Green](https://www.sparkfun.com/metal-pushbutton-momentary-16mm-green.html) (SKU: COM-11968)

---

## Part 1: Hardware Specifications

### Button Electrical Ratings
| Parameter | Value |
| --- | --- |
| Switch Type | SPDT (Single Pole Double Throw) |
| Operation | Momentary |
| Switch Rating | 3A @ 250VAC max |
| LED Voltage | 5-12V |
| Body | Stainless steel, IP65 weatherproof |
| Thread | 16mm diameter, 1mm pitch |
| Overall Length | ~1.5 inches (with leads) |

### Wire Color Pinout
| Wire Color | Function | Description |
| --- | --- | --- |
| **Red** | LED+ | LED positive (anode) |
| **Black** | LED- | LED negative (cathode/ground) |
| **Yellow** | C1 (Common) | Switch common terminal → PB9 (D6) |
| **White** | NO1 (Normally Open) | Open until pressed → GND |
| **Blue** | NC1 (Normally Closed) | **NOT CONNECTED** |

---

## Part 2: Hardware Wiring

### Required GPIO Pins

| Function | STM32 Pin | Arduino # | Notes |
| --- | --- | --- | --- |
| Button Input | PB9 | D6 | Internal pull-up enabled |
| LED Output | PB13 | D10 | Via 100Ω current-limiting resistor |

### Wiring Diagram

```
                    STM32L433 (Cygnet)
                    ┌─────────────────┐
                    │                 │
    ┌───────────────┤ PB9 (D6)        │◄── Button Input (with pull-up)
    │               │                 │
    │   ┌───────────┤ PB13 (D10)      │──► LED Control Output
    │   │           │                 │
    │   │       ┌───┤ 3.3V            │
    │   │       │   │                 │
    │   │       │   ├─────────────────┤
    │   │       │   │ GND             │
    │   │       │   └────┬────────────┘
    │   │       │        │
    │   │       │        │
    │   │       │        │
    ▼   ▼       ▼        ▼

    PANEL MOUNT BUTTON (COM-11968)
    ┌─────────────────────────────┐
    │                             │
    │  ┌─────┐         ┌─────┐   │
    │  │ LED │         │SWITCH│  │
    │  │     │         │      │  │
    │  │ (+) │         │ COM  │──┼──► YELLOW wire ──► PB9 (D6)
    │  │  │  │         │      │  │
    │  │  │  │         │ NO   │──┼──► WHITE wire ──► GND
    │  │  │  │         │      │  │
    │  │  │  │         │ NC   │──┼──► BLUE wire ──► (not connected)
    │  │ (-) │         │      │  │
    │  │  │  │         └──────┘  │
    │  └──┼──┘                   │
    │     │                      │
    └─────┼──────────────────────┘
          │
          ├──► BLACK wire ──► GND
          │
    ┌─────┴─────┐
    │    RED    │──► 330Ω resistor ──► GPIO (LED)
    │   wire    │
    └───────────┘
```

### Switch Wiring (Normally Open Configuration)

For active-low button detection with internal pull-up:

```
                  3.3V
                   │
                   │
            ┌──────┴──────┐
            │  Internal   │
            │  Pull-Up    │
            │  (~40kΩ)    │
            └──────┬──────┘
                   │
    PB9  ◄─────────┼───────── YELLOW (Common/C1)
    (D6)       │
                   │
              ┌────┴────┐
              │   NO    │
              │ Contact │
              └────┬────┘
                   │
                  GND ◄────── WHITE (NO1) tied to GND
```

**Logic**:
- Button NOT pressed: GPIO reads HIGH (pulled up)
- Button pressed: GPIO reads LOW (NO closes, connects to GND)

**Alternative wiring** (if using external pull-up):
- Connect WHITE (NO) to GND
- Connect YELLOW (Common) to GPIO with external 10kΩ pull-up to 3.3V

### LED Wiring (Direct 3.3V Drive)

```
    PB13 (D10) ───► 100Ω ───► RED wire (LED+)
                                    │
                              ┌─────┴─────┐
                              │    LED    │
                              │  (Green)  │
                              └─────┬─────┘
                                    │
                              BLACK wire (LED-)
                                    │
                                   GND
```

**Why the 100Ω resistor is required:**
- Without it, the LED draws excessive current (50-100mA+), risking damage to both the GPIO pin (max ~25mA) and the LED
- With 100Ω: I = (3.3V - 2.1V) / 100Ω ≈ 12mA (safe for GPIO and LED)
- If LED is too dim, try 68Ω (~18mA) or 47Ω (~25mA max)

**Note**: The LED may be slightly dim at 3.3V since it's rated for 5-12V. Test brightness before final assembly.

---

## Part 3: Firmware Changes

### 3.1 Update GPIO Pin Definitions

**File**: `songbird-firmware/src/core/SongbirdConfig.h`

```cpp
// Before (current):
#define BUTTON_PIN      USER_BTN    // User button (optional), internal pull-up
#define LED_PIN         LED_BUILTIN // Built-in LED on Cygnet

// After (add external button, keep internal as backup):
#define BUTTON_PIN      PB9         // External panel mount button (D6)
#define BUTTON_PIN_ALT  USER_BTN    // Internal Cygnet button (PC13) as backup
#define LOCK_LED_PIN    PB13        // Panel mount button LED (D10)
#define LED_PIN         LED_BUILTIN // Keep built-in LED for status/debug
```

### 3.1a Update Button Handler for Dual-Button Support

**File**: `songbird-firmware/src/rtos/SongbirdTasks.cpp`

Modify button reading logic to check both buttons (OR logic):

```cpp
// Read both buttons (either can trigger)
bool currentButtonState = digitalRead(BUTTON_PIN) && digitalRead(BUTTON_PIN_ALT);
// Both are active-low with pull-up, so AND gives HIGH only when BOTH are not pressed
// If either is pressed (LOW), result is LOW
```

**File**: `songbird-firmware/src/main.cpp`

In `setup()`, initialize both button pins:

```cpp
// Initialize both button inputs
pinMode(BUTTON_PIN, INPUT_PULLUP);      // External panel mount button
pinMode(BUTTON_PIN_ALT, INPUT_PULLUP);  // Internal Cygnet button (backup)
```

### 3.2 Add LED Control Functions

**File**: `songbird-firmware/src/core/SongbirdState.h` (add to header)

```cpp
// LED control for lock status indicator
void stateUpdateLockLED();
```

**File**: `songbird-firmware/src/core/SongbirdState.cpp` (add implementation)

```cpp
/**
 * Update the lock indicator LED based on current lock state.
 * LED is ON when either transit lock or demo lock is engaged.
 */
void stateUpdateLockLED() {
    bool lockActive = stateIsTransitLocked() || stateIsDemoLocked();
    digitalWrite(LOCK_LED_PIN, lockActive ? HIGH : LOW);
}
```

### 3.3 Initialize LED Pin

**File**: `songbird-firmware/src/main.cpp`

In `setup()`, add after existing GPIO initialization:

```cpp
// Initialize lock indicator LED
pinMode(LOCK_LED_PIN, OUTPUT);
digitalWrite(LOCK_LED_PIN, LOW);  // Start with LED off

// Restore LED state if lock was previously active
stateUpdateLockLED();
```

### 3.4 Update Button Handlers to Control LED

**File**: `songbird-firmware/src/rtos/SongbirdTasks.cpp`

Update the transit lock toggle (around line 468-531):

```cpp
// Single click - toggle transit lock
if (s_clickCount == 1 && elapsed >= TRIPLE_CLICK_TIMEOUT_MS) {
    // Guard: reject if demo lock is active
    if (stateIsDemoLocked() && !stateIsTransitLocked()) {
        audioQueueEvent(AUDIO_EVENT_ERROR);
    }
    else if (stateIsTransitLocked()) {
        // Unlock: restore previous mode
        OperatingMode previousMode = stateGetPreTransitMode();
        stateSetTransitLock(false, MODE_DEMO);
        stateSetMode(previousMode);
        notecardConfigure(previousMode);
        audioQueueEvent(AUDIO_EVENT_TRANSIT_LOCK_OFF);
        stateUpdateLockLED();  // <-- ADD THIS
    } else {
        // Lock: save current mode and switch to transit
        OperatingMode currentMode = s_currentConfig.mode;
        stateSetTransitLock(true, currentMode);
        stateSetMode(MODE_TRANSIT);
        notecardConfigure(MODE_TRANSIT);
        audioQueueEvent(AUDIO_EVENT_TRANSIT_LOCK_ON);
        stateUpdateLockLED();  // <-- ADD THIS
    }
}
```

Update the demo lock toggle (around line 404-467):

```cpp
// Double-click detected - toggle demo lock
if (s_clickCount == 2 && elapsed >= MULTI_CLICK_WINDOW_MS && elapsed < TRIPLE_CLICK_TIMEOUT_MS) {
    // Guard: reject if transit lock is active
    if (stateIsTransitLocked() && !stateIsDemoLocked()) {
        audioQueueEvent(AUDIO_EVENT_ERROR);
    }
    else if (stateIsDemoLocked()) {
        // Unlock: restore previous mode
        OperatingMode previousMode = stateGetPreDemoMode();
        stateSetDemoLock(false, MODE_DEMO);
        stateSetMode(previousMode);
        notecardConfigure(previousMode);
        audioQueueEvent(AUDIO_EVENT_DEMO_LOCK_OFF);
        stateUpdateLockLED();  // <-- ADD THIS
    } else {
        // Lock: save current mode and switch to demo
        OperatingMode currentMode = s_currentConfig.mode;
        stateSetDemoLock(true, currentMode);
        stateSetMode(MODE_DEMO);
        notecardConfigure(MODE_DEMO);
        audioQueueEvent(AUDIO_EVENT_DEMO_LOCK_ON);
        stateUpdateLockLED();  // <-- ADD THIS
    }
}
```

### 3.5 Update State Restoration

**File**: `songbird-firmware/src/core/SongbirdState.cpp`

In `stateRestore()` function, after restoring lock states:

```cpp
// After state restoration, update LED to reflect restored lock state
stateUpdateLockLED();
```

---

## Part 4: Testing Checklist

### Hardware Testing
- [ ] Button press detected correctly (GPIO reads LOW when pressed)
- [ ] Button debounce works properly (no false triggers)
- [ ] LED lights up when 3.3V applied through 100Ω resistor (verify LED works)
- [ ] LED turns on/off from GPIO control

### Firmware Testing
- [ ] Single-click toggles transit lock
- [ ] LED turns ON when transit lock is engaged
- [ ] LED turns OFF when transit lock is disengaged
- [ ] Double-click toggles demo lock
- [ ] LED turns ON when demo lock is engaged
- [ ] LED turns OFF when demo lock is disengaged
- [ ] Triple-click toggles mute (LED unchanged)
- [ ] LED state persists across sleep/wake cycles
- [ ] LED state correct after power cycle with saved lock state

---

## Part 5: Bill of Materials

| Qty | Part | Description | Source |
| --- | --- | --- | --- |
| 1 | COM-11968 | Metal Pushbutton Momentary 16mm Green | SparkFun |
| 1 | 100Ω resistor | 1/4W, current-limiting for LED | DigiKey/Mouser |
| - | Wire | 22-24 AWG stranded for connections | - |
| - | Heat shrink | For insulating solder joints | - |

---

## Acceptance Criteria

- [ ] Panel mount button physically installed in enclosure
- [ ] Button wired correctly to STM32 GPIO
- [ ] LED wired correctly with proper current limiting
- [ ] Single-click activates/deactivates transit lock with LED feedback
- [ ] Double-click activates/deactivates demo lock with LED feedback
- [ ] Triple-click mute toggle still works
- [ ] LED state survives power cycle when lock was engaged
- [ ] Audio feedback (melodies) still play correctly
- [ ] No interference with existing Notecard/sensor/buzzer functionality
- [ ] Internal Cygnet button (PC13) still works as backup

---

## Notes

### Pin Selection
Selected pins based on Cygnet variant_CYGNET.h:
- **PB9 (D6)**: Button input - general purpose GPIO, not used by other peripherals
- **PB13 (D10)**: LED output - general purpose GPIO, not used by other peripherals

Pins to avoid (already in use):
- PB6/PB7: I2C (Notecard, BME280, Buzzer)
- PB10/PB11: Debug serial (STLink VCP)
- PA8: LED_BUILTIN
- PC13: USER_BTN (internal button, kept as backup)

### Enclosure Modifications
- The 16mm button requires a 16mm (5/8") mounting hole
- Button thread depth is ~12mm, ensure panel thickness is appropriate
- Consider waterproofing if used outdoors (button is IP65 rated)

### Future Enhancements
- LED blink pattern to distinguish transit vs demo lock
- Different LED colors for different states (would require different button)
- Long-press to enter configuration mode
