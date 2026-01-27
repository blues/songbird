# Songbird Demo Script
## Sales & FAE Guide for Demonstrating Blues Notecard & Notehub

---

## Pre-Demo Setup Checklist

### Hardware
- [ ] Songbird device charged (check battery in dashboard)
- [ ] Songbird powered ON and connected (green status in dashboard)
- [ ] Device in **Demo mode** (immediate sync, triangulation)
- [ ] Audio volume set to audible level (50-100%)

### Software
- [ ] Songbird dashboard open: `https://songbird.live`
- [ ] Notehub open in separate tab: `https://notehub.io`
- [ ] Logged in to both with appropriate permissions
- [ ] Device visible on Fleet Map

### Environment
- [ ] Near window if showing GPS (or use triangulation for indoor)
- [ ] Quiet enough to hear audio feedback
- [ ] Screen sharing ready (if remote demo)

---

## Demo Flow Overview

| Section | Duration | Key Capabilities |
| --- | --- | --- |
| 1. Introduction | 2 min | Set the stage |
| 2. Zero-Config Connectivity | 3 min | Cellular simplicity |
| 3. Location Services | 4 min | GPS + triangulation |
| 4. Remote Commands | 3 min | Cloud-to-device |
| 5. Configuration | 3 min | Environment variables |
| 6. Data Flow | 3 min | Events + routing |
| 7. Power & Battery | 2 min | Low-power features |
| 8. OTA Updates | 2 min | Firmware management |
| 9. Wrap-up | 3 min | Q&A, next steps |

**Total: \~25 minutes** (adjust based on audience interest)

---

## Section 1: Introduction (2 minutes)

### What to Say

> "I'm going to show you what's possible with Blues Notecard and Notehub using this Songbird device. Songbird is our internal sales demo platform—it's not a product we sell, but everything you see it doing is powered by the same Notecard and Notehub that your customers would use.
>
> The goal today is to show you how Blues makes cellular IoT dramatically simpler. By the end, you'll see why developers can go from idea to production in weeks instead of months."

### What to Show

- Hold up the Songbird device
- Point out the Notecard (if visible) or mention it's inside
- Show the dashboard with the device online

### Key Message

**Blues handles connectivity so developers focus on their application.**

---

## Section 2: Zero-Configuration Connectivity (3 minutes)

### What to Say

> "Let's start with cellular connectivity. Traditionally, connecting a device to cellular requires AT commands, modem drivers, APN configuration, and certificate management. It's thousands of lines of code and months of development.
>
> With Notecard, it's one JSON command."

### What to Show

**Notehub UI:**
1. Navigate to the Songbird project
2. Click on the device
3. Show the **Events** tab with recent events flowing

> "See these events coming in? The device is sending sensor data over cellular right now. Let me show you what the code looks like."

**Show this API call (on slide or notepad):**
```json
{"req": "hub.set", "product": "com.blues.songbird", "mode": "continuous"}
```

> "That's it. One line. The Notecard handles SIM activation, carrier selection, TLS certificates, reconnection logic—everything. The 10-year prepaid SIM is already inside."

### What to Emphasize

- **No AT commands** — Developers use JSON over I2C
- **No cellular expertise required** — Any embedded developer can do this
- **Pre-provisioned security** — TLS certificates rotate automatically

### Talking Point if Asked

> "The SIM inside Notecard works globally across 140+ countries with 500MB prepaid. No carrier contracts, no monthly fees until you exceed that."

---

## Section 3: Location Services (4 minutes)

### 3A: GPS Tracking

### What to Say

> "Now let's look at location. Notecard has GPS built in—no external module, no antenna design, no NMEA parsing code."

### What to Show

**Songbird Dashboard:**
1. Go to **Device Detail** page
2. Click the **Location** tab
3. Show the map with the device position

> "This position came from the Notecard's built-in GPS. In the firmware, getting location is just:"

```json
{"req": "card.location"}
```

> "Returns latitude, longitude, and accuracy. That's all the code needed."

**If device has GPS fix:**
> "You can see the position is quite accurate—this is real GPS, not just cell tower approximation."

### 3B: Autonomous Tracking (The Killer Feature)

### What to Say

> "Here's where it gets really impressive. Notecard can track location **autonomously**—meaning the main processor can be completely powered off, and Notecard will still log GPS points when it detects motion."

### What to Show

**Shake the Songbird device gently**, then:

1. Wait 30-60 seconds
2. Refresh the dashboard
3. Show new track point appearing

> "See that? I just shook the device. The Notecard detected motion with its built-in accelerometer, woke up the GPS, captured the position along with velocity and bearing, and sent it to the cloud. The main processor never woke up."

**Show \****`_track.qo`**\*\* event in Notehub:**
1. Go to device Events in Notehub
2. Find the `_track.qo` event
3. Expand to show: lat, lon, velocity, bearing, distance

> "Look at this data—velocity, bearing, distance from last point. All calculated automatically by Notecard. Zero lines of code on the device."

### Key Message

> "This is the killer feature for asset tracking. A $49 Notecard replaces a $300 dedicated GPS tracker, and it does it with lower power consumption because the MCU can stay asleep."

### 3C: Triangulation Fallback

### What to Say

> "GPS doesn't work indoors. That's why Notecard also supports cell tower and WiFi triangulation."

### What to Show

**In Notehub, show location source:**
1. Find a triangulation event (or if currently indoors)
2. Show the location with `triangulate` source

> "When GPS isn't available, Notecard observes nearby cell towers and WiFi access points, sends them to Notehub, and Notehub queries carrier databases to estimate position. It's less accurate than GPS—maybe 100-500 meters—but it works indoors, instantly, with lower power."

### Demo Mode Tip

> "In demo mode, Songbird uses triangulation only. That's intentional—it means we can do demos indoors without waiting for GPS lock."

---

## Section 4: Remote Commands (3 minutes)

### What to Say

> "Let's send a command to the device from the cloud. This is bidirectional communication—without MQTT brokers, without persistent connections."

### What to Show

**Songbird Dashboard:**
1. Go to **Device Detail** page
2. Find the **Quick Actions** section
3. Click **Locate**

> "I'm sending a 'locate' command. This tells the device to play an audible beacon—useful for finding a device in a warehouse."

**Wait for the device to beep** (should be within 5-30 seconds depending on mode)

> "There it is! The command went from my browser, to our backend, to Notehub, to the Notecard, and the device executed it."

### What to Show Next

**In Notehub:**
1. Go to device Events
2. Find `command_ack.qo` event
3. Show the acknowledgment

> "And here's the acknowledgment—the device confirmed it executed the command. This is a full command-response loop."

### Explain the Magic

> "How does this work without a persistent connection? Notecard polls for inbound commands in the background. When a command arrives at Notehub, the next time Notecard checks in, it receives the command and wakes the host processor if needed.
>
> In demo mode, it's checking every second so response is immediate. In other modes, you trade latency for power savings."

### Notehub API

> "From an API perspective, sending a command is just a POST to Notehub:"

```
POST /v1/projects/{uid}/devices/{uid}/notes/command.qi
{"body": {"cmd": "locate", "duration": 30}}
```

---

## Section 5: Remote Configuration (3 minutes)

### What to Say

> "Now let's change the device's behavior without touching the firmware. This is environment variables—cloud-based configuration that the device reads on boot and whenever it changes."

### What to Show

**Option A: Notehub UI**

1. In Notehub, go to device **Environment** tab
2. Show current variables (mode, thresholds, intervals)
3. Change a value (e.g., `temp_alert_high_c` from 35 to 25)
4. Click Save

> "I just lowered the temperature alert threshold. The device will pick up this change within seconds."

**Option B: Songbird Dashboard**

1. Go to Device Detail → **Configuration** tab
2. Use the slider to adjust a threshold
3. Click Save

> "Same thing from our dashboard—we're calling the Notehub API under the hood."

### Wait and Observe

> "Watch the device... it's now checking for environment changes. In demo mode this happens every few seconds."

**Show the device received the change:**
- Either wait for an alert (if temp exceeds new threshold)
- Or explain that the device applied the new config

### Key Point

> "This is huge for operations. You can change device behavior across your entire fleet without pushing firmware updates. Adjust thresholds, change reporting intervals, enable or disable features—all from the cloud."

### Fleet Defaults

> "And you can set fleet defaults that apply to all devices at once:"

```
PUT /v1/projects/{uid}/fleets/{uid}/environment_variables
{"mode": "transit", "sync_interval_min": 15}
```

> "One API call configures thousands of devices."

---

## Section 6: Data Flow & Events (3 minutes)

### What to Say

> "Let's look at how data flows from device to cloud to application."

### What to Show

**Notehub Events Tab:**
1. Navigate to device Events
2. Show different event types

> "Here are the events from this device. Let me explain what each one is:"

### Event Types to Highlight

| Event | Description | What to Say |
| --- | --- | --- |
| `track.qo` | Sensor telemetry | "Temperature, humidity, pressure from the BME280 sensor" |
| `_track.qo` | GPS tracking | "Autonomous GPS points—velocity, bearing, distance" |
| `alert.qo` | Threshold alerts | "Device-generated alerts when thresholds exceeded" |
| `_health.qo` | Device health | "Battery voltage, restarts, power mode changes" |
| `command_ack.qo` | Command acknowledgments | "Confirmation that commands executed" |

### Show Routing

**Notehub Routes:**
1. Go to project Settings → Routes
2. Show the HTTP route to your backend

> "Notehub is a router—it receives events from devices and forwards them wherever you need. This route sends events to our AWS Lambda, which stores them in DynamoDB and powers the dashboard.
>
> You can route to AWS IoT, Azure IoT Hub, your own MQTT broker, or any HTTP endpoint. Multiple routes can run in parallel."

### Template Compression

> "One more thing—see how small these events are over cellular? That's because Notecard uses templates. We define the data schema once, and Notecard sends compact binary instead of verbose JSON. It saves 80-90% bandwidth."

---

## Section 7: Power & Battery (2 minutes)

### What to Say

> "Power management is critical for battery-operated devices. Blues makes this dramatically simpler."

### What to Show

**Songbird Dashboard:**
1. Show battery voltage on Device Detail
2. Show USB power indicator (if connected)

> "Notecard monitors battery continuously. It knows the LiPo discharge curve, so this percentage is accurate. If battery gets low, Notecard automatically generates an alert and syncs it immediately—before the battery dies."

### Sleep Mode

> "For deep power savings, Notecard can cut power to the host processor entirely. The ATTN pin controls the power switch on the Notecarrier.
>
> In sleep mode, the MCU is completely off—zero current. Notecard stays in standby at about 8 microamps, and it can wake the MCU on a timer, on motion detection, or when a command arrives from the cloud.
>
> No RTC, no wake circuits, no complex state machines. Just one API call."

```json
{"req": "card.attn", "mode": "sleep,motion,files", "files": ["command.qi"], "seconds": 3600}
```

### Built-in Accelerometer

> "And motion detection? That's built into Notecard too. No external accelerometer needed. It's how autonomous tracking works—Notecard detects motion and captures GPS without waking the MCU."

---

## Section 8: Over-the-Air Updates (2 minutes)

### What to Say

> "Finally, let's talk about firmware updates. Traditionally, OTA requires a custom bootloader—that's 1,000-2,000 lines of code, dual partition schemes, integrity checking, rollback logic."

### What to Show

**Songbird Dashboard Firmware Page** (or Notehub DFU section):
1. Show list of available firmware versions
2. Show device's current version
3. Explain the update flow (don't actually trigger one in demo)

> "With Blues, there's no bootloader code needed. You upload your firmware binary to Notehub, select which devices or fleets to update, and Notecard does the rest.
>
> Notecard downloads the firmware in the background, verifies integrity, puts the host MCU into bootloader mode using the ROM bootloader, flashes the new firmware, and reboots. All automatically."

### API

> "From an API perspective:"

```
POST /v1/projects/{uid}/dfu/host/update?fleetUID={fleet}
```

> "One API call updates your entire fleet."

### Key Point

> "This is a huge time saver. No bootloader development, no partition management, no custom update protocol. Just upload the binary and deploy."

---

## Section 9: Wrap-up & Q&A (3 minutes)

### Summary

> "Let's recap what we just demonstrated:
>
> 1. **Zero-config cellular** — One JSON command, no AT commands, no modem drivers
> 2. **Built-in GPS** — No external module, no NMEA parsing
> 3. **Autonomous tracking** — MCU can sleep while Notecard logs GPS
> 4. **Remote commands** — Cloud-to-device without MQTT complexity
> 5. **Environment variables** — Change device behavior without firmware updates
> 6. **Event routing** — Data flows to any backend via Notehub
> 7. **Power management** — Sub-10 microamp sleep, built-in battery monitoring
> 8. **OTA updates** — No bootloader code required
>
> All of this in a $49 device with a 10-year prepaid SIM."

### Competitive Positioning

**If asked "How does this compare to...":**

| Competitor | Response |
| --- | --- |
| **Particle** | "Particle Tracker requires the MCU to stay awake for GPS. Notecard tracks autonomously with the MCU powered off. That's 10x battery life improvement for asset tracking." |
| **AWS IoT** | "AWS provides cloud infrastructure, but you still need to build the modem driver, GPS parsing, power management, OTA bootloader. Blues handles all of that on-device." |
| **Hologram** | "Hologram is SIM-only. Great connectivity, but no GPS, no accelerometer, no OTA, no templates. You'd need to build or buy all that separately." |

### Next Steps

> "For your customers, the path forward is:
>
> 1. **Evaluate** — Notecard Starter Kit is $99, 30 minutes to first data
> 2. **Prototype** — Full JSON API docs at dev.blues.io
> 3. **Production** — Volume pricing, custom Notecards, reference designs available
>
> Songbird source code is available as a reference architecture. Customers can copy patterns directly."

### Q&A Prompts

> "What questions do you have? I'm happy to dive deeper into any of these areas or show additional features."

---

## Appendix: Common Questions & Answers

### Connectivity

**Q: What carriers does Notecard support?**
> "Notecard has a global SIM that works on 140+ carriers in 140+ countries. It automatically selects the best available network. No carrier contracts needed—500MB is prepaid for 10 years."

**Q: What if there's no cellular coverage?**
> "Notecard queues data locally and syncs when coverage returns. For areas with truly no coverage, we have LoRa and satellite options."

**Q: How secure is the connection?**
> "All communication uses TLS 1.2+ with certificates pre-provisioned and auto-rotating. Data is encrypted end-to-end from device to Notehub. You can add your own encryption on top if needed."

### GPS & Location

**Q: How accurate is the GPS?**
> "Typically 2-5 meters outdoors with clear sky. Notecard reports DOP (dilution of precision) so you know the accuracy of each fix."

**Q: How long does GPS take to get a fix?**
> "Cold start is typically 30-60 seconds. Warm start (recent fix) is 5-10 seconds. Notecard optimizes for power by using assisted GPS data from the cellular network."

**Q: Does it work indoors?**
> "GPS doesn't work indoors, but triangulation does. Notecard can use cell towers and WiFi for indoor positioning with ~100-500m accuracy."

### Power

**Q: What's the battery life?**
> "Depends entirely on use case. In sleep mode with hourly check-ins, a 2000mAh battery can last months. In continuous tracking mode, more like days. Songbird shows how to optimize for different scenarios."

**Q: What battery voltage does it support?**
> "Notecard runs on 3.3-5.5V, perfect for single-cell LiPo (3.7V nominal). The Notecarrier provides battery management."

### Data & Costs

**Q: How much data does it use?**
> "With templates, a typical sensor reading is 20-30 bytes over the air. GPS points are ~32 bytes. At 24 readings/day, you'd use ~1MB/month. The included 500MB lasts years for most applications."

**Q: What happens when I run out of data?**
> "You buy more through Notehub. Pricing is per-consumption, not per-device monthly fees. Volume discounts available."

**Q: Can I use my own SIM?**
> "Yes, Notecard supports external SIM for specific carrier requirements. But for most use cases, the built-in global SIM is simpler and more cost-effective."

### Integration

**Q: How do I get data into my system?**
> "Notehub routes data via HTTP webhooks, AWS IoT, Azure IoT, MQTT, or custom integrations. Most customers use HTTP to their backend—it's the simplest."

**Q: Can I use Notecard without Notehub?**
> "Notecard requires Notehub as the initial endpoint—it's how we provide security and reliability. But you can route data anywhere from Notehub, and there's no lock-in on your backend."

**Q: Is there an SDK?**
> "Yes, note-c (C), note-arduino (Arduino), note-python, and note-go. All open source. But you can also just send JSON commands directly—no SDK required."

---

## Appendix: Demo Recovery Tips

### Device Not Responding

1. Check battery level in dashboard (may be dead)
2. Check mode—sleep mode has longer polling intervals
3. Power cycle the device
4. Check Notehub for recent events to confirm connectivity

### Commands Not Executing

1. Verify device is in demo mode (1-second polling)
2. Check audio volume isn't zero
3. Look for command in Notehub events—did it arrive?
4. Check `command_ack.qo` for error status

### No Location Showing

1. Indoor? GPS won't work—use triangulation
2. Check device has been on long enough for GPS fix (~60 sec)
3. Look for `_track.qo` events in Notehub
4. Demo mode uses triangulation only by default

### Dashboard Not Updating

1. Hard refresh the browser (Cmd+Shift+R / Ctrl+Shift+R)
2. Check device last_seen timestamp—is it recent?
3. Verify Notehub route is enabled and healthy
4. Check browser console for API errors

---

## Quick Reference: Key Demo Points

| Feature | Demo Action | What to Say |
| --- | --- | --- |
| Connectivity | Show events in Notehub | "One JSON command replaces modem driver" |
| GPS | Show location on map | "Built-in GPS, no NMEA parsing" |
| Autonomous tracking | Shake device, show new point | "MCU sleeps, Notecard tracks" |
| Commands | Send locate, hear beep | "Cloud-to-device without MQTT" |
| Configuration | Change threshold | "No firmware update needed" |
| Battery | Show voltage | "Built-in monitoring, no ADC" |
| OTA | Show firmware page | "No bootloader code required" |

---

*Document Version: 1.0*
*Last Updated: January 2025*
