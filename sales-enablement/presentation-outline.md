# Blues Notecard & Notehub Capabilities
## Presentation Deck Outline — Using Songbird as the Demo Vehicle

**Purpose**: Enable Blues Sales and FAE to confidently demonstrate key Notecard and Notehub capabilities using Songbird as a tangible, hands-on example.

**Key Message**: Songbird exists to showcase what's possible with Blues—the star of the show is the Notecard and Notehub platform, not Songbird itself.

---

## Slide 1: Title
**Blues Notecard & Notehub: Complete IoT Infrastructure in One Platform**

- Subtitle: "From device to cloud in minutes, not months"
- Songbird demo device image

---

## Slide 2: What We'll Cover

1. Zero-Configuration Cellular Connectivity
2. Built-in GPS & Location Services
3. Autonomous Asset Tracking (MCU can sleep)
4. Cloud-to-Device Commands & Configuration
5. Over-the-Air Firmware Updates
6. Data Optimization (80%+ bandwidth savings)
7. Power Management (sub-10μA sleep)
8. Fleet Management at Scale

*"Each capability demonstrated live with Songbird"*

---

## Slide 3: The Problem We Solve

**Traditional Cellular IoT Development**:
- 6-12 months to production
- 5,000-10,000+ lines of connectivity code
- Cellular expertise required (AT commands, modem drivers)
- GPS module integration & NMEA parsing
- TLS certificate management
- Custom bootloaders for OTA updates
- Complex power management state machines

**With Blues**:
- Days to prototype, weeks to production
- ~1,000 lines of application code
- JSON API over I2C—no cellular expertise needed
- Everything built into Notecard

---

## Slide 4: Architecture Overview

```
┌──────────────────┐
│  Your MCU/App    │  ← Application logic only
└────────┬─────────┘
         │ JSON over I2C/Serial
         ▼
┌──────────────────┐
│    Notecard      │  ← Cellular, GPS, power, security
└────────┬─────────┘
         │ Cellular (LTE-M/NB-IoT/Cat-1)
         ▼
┌──────────────────┐
│     Notehub      │  ← Cloud router, device management
└────────┬─────────┘
         │ HTTP/MQTT/Custom routes
         ▼
┌──────────────────┐
│   Your Backend   │  ← Dashboard, analytics, ERP
└──────────────────┘
```

**Songbird implements all four layers—we'll show each one.**

---

## SECTION 1: ZERO-CONFIGURATION CELLULAR

### Slide 5: One API Call Replaces Thousands of Lines

**Traditional Modem Setup**:
```
AT+CGDCONT=1,"IP","hologram"
AT+CGATT=1
AT+CGACT=1,1
AT+CIPMUX=0
AT+CIPSTART="TCP","api.example.com",443
... 50+ more AT commands
... retry logic, error handling, reconnection
```

**Blues Notecard**:
```json
{"req": "hub.set", "product": "com.blues.songbird", "mode": "periodic"}
```

**That's it.** Notecard handles:
- SIM activation (10-year prepaid, 500MB included)
- APN configuration (automatic carrier detection)
- Network registration & roaming
- TLS certificates (pre-provisioned, auto-rotating)
- Reconnection with exponential backoff
- Signal optimization

**DEMO**: Show Songbird connecting—no configuration needed.

---

### Slide 6: Flexible Sync Modes

| Mode | Behavior | Power | Use Case |
| --- | --- | --- | --- |
| `continuous` | Always connected | Higher | Real-time dashboards |
| `periodic` | Connect every N minutes | Balanced | Regular reporting |
| `minimum` | Only when data pending | Lowest | Event-driven |

**Songbird Implementation**:
- **Demo mode**: `continuous` for instant updates during demos
- **Transit mode**: `periodic` (10 min) for shipping updates
- **Storage mode**: `periodic` (60 min) for warehouse check-ins
- **Sleep mode**: `minimum` for long-term storage

**DEMO**: Change mode in Notehub UI → watch device reconfigure in <30 seconds.

---

## SECTION 2: BUILT-IN GPS & LOCATION

### Slide 7: GPS Without the Pain

**What customers typically need**:
- GPS module ($15-30)
- Antenna design & certification
- NMEA parsing library (400+ lines)
- Time-to-first-fix optimization
- Power management for GPS module
- Satellite visibility detection

**What Notecard provides**:
- GPS/GNSS receiver built-in
- Antenna integrated (external option available)
- One JSON call to get position

```json
{"req": "card.location.mode", "mode": "periodic", "seconds": 60}
```

**Returns**:
```json
{"lat": 37.7749, "lon": -122.4194, "time": 1705346400}
```

**DEMO**: Show Songbird GPS fix on map—indoors with window, or outdoors.

---

### Slide 8: Triangulation Fallback

**GPS limitations**:
- No signal indoors
- Urban canyon issues
- 30-60 second time-to-fix
- Higher power consumption

**Notecard triangulation**:
```json
{"req": "card.triangulate", "mode": "wifi,cell"}
```

- Uses cell tower + WiFi AP databases
- Works indoors immediately
- ~100-500m accuracy (varies by density)
- Server-side processing (no extra device power)

**Songbird Demo Mode**: GPS disabled, triangulation only—perfect for indoor trade show demos.

**DEMO**: Show triangulation working indoors.

---

## SECTION 3: AUTONOMOUS ASSET TRACKING

### Slide 9: The Killer Feature—MCU Can Sleep

**Traditional GPS tracking**:
1. MCU wakes on timer
2. MCU powers GPS
3. MCU waits for fix (30-90 sec)
4. MCU reads NMEA, parses coordinates
5. MCU opens cellular connection
6. MCU sends data
7. MCU goes back to sleep

**MCU active entire time. 5-10 minutes per update.**

**Blues Notecard**:
```json
{"req": "card.location.track", "start": true, "sync": true}
```

**Then MCU can power off completely.**

Notecard autonomously:
1. Detects motion (built-in accelerometer)
2. Wakes GPS
3. Captures position + velocity + bearing
4. Logs to `_track.qo` notefile
5. Syncs to Notehub
6. Returns to standby

**MCU never wakes. Battery lasts 10x longer.**

---

### Slide 10: What Autonomous Tracking Captures

**Automatic \****`_track.qo`**\*\* fields**:
| Field | Description |
| --- | --- |
| `lat`, `lon` | GPS coordinates |
| `velocity` | Speed (m/s) |
| `bearing` | Heading (degrees) |
| `distance` | Distance from last point (m) |
| `dop` | Dilution of precision (accuracy) |
| `journey` | Journey identifier |

**All calculated by Notecard. Zero MCU code.**

**DEMO**: Shake Songbird device → show track point appear in dashboard with velocity.

---

### Slide 11: Journey Visualization

**Notehub + Dashboard**:
- Journey ID groups related track points
- Dashboard shows complete route history
- Mapbox Map Matching snaps to roads
- Playback mode animates the journey

**Use Cases**:
- Supply chain: "Where has this shipment been?"
- Fleet: "Show me driver routes"
- Logistics: "Verify delivery path"

**DEMO**: Show journey playback in Songbird dashboard.

---

## SECTION 4: CLOUD-TO-DEVICE COMMANDS

### Slide 12: Bidirectional Communication

**Traditional approach**:
- MQTT broker setup & maintenance
- Persistent connections (power hungry)
- Certificate management
- Reconnection logic
- Message acknowledgment

**Blues approach**:

**Send command (from cloud via Notehub API)**:
```
POST /v1/projects/{uid}/devices/{uid}/notes/command.qi
{"body": {"cmd": "locate", "params": {"duration_sec": 30}}}
```

**Receive command (on device) — ****`note.get`**:
```json
{"req": "note.get", "file": "command.qi", "delete": true}
```

**Response contains the command**:
```json
{
  "body": {
    "cmd": "locate",
    "command_id": "uuid-1234",
    "params": {"duration_sec": 30}
  }
}
```

**Firmware: Poll for commands & execute**:
```cpp
// Check for inbound command (atomic read-and-delete)
Command cmd;
if (notecardGetCommand(&cmd)) {
    // Execute the command
    CommandAck ack;
    commandsExecute(&cmd, &config, &ack);

    // Send acknowledgment back to cloud
    syncQueueNote(&ack);  // Queues to command_ack.qo
}
```

**Firmware: Send acknowledgment — ****`note.add`**:
```json
{"req": "note.add", "file": "command_ack.qo", "sync": true, "body": {...}}
```

```cpp
// note.add to command_ack.qo with sync:true for immediate delivery
J* req = notecard.newRequest("note.add");
JAddStringToObject(req, "file", "command_ack.qo");
JAddBoolToObject(req, "sync", true);  // Immediate sync

J* body = JCreateObject();
JAddStringToObject(body, "cmd_id", ack->commandId);
JAddStringToObject(body, "cmd", "locate");
JAddStringToObject(body, "status", "ok");
JAddStringToObject(body, "message", "Locate started for 30 seconds");
JAddItemToObject(req, "body", body);

notecard.sendRequest(req);
```

**Resulting ****`command_ack.qo`**** event in Notehub**:
```json
{
  "cmd_id": "uuid-1234",
  "cmd": "locate",
  "status": "ok",
  "message": "Locate started for 30 seconds",
  "executed_at": 1705346400
}
```

**Device doesn't need persistent connection.** Notecard polls in background, wakes MCU when command arrives.

---

### Slide 13: Songbird Commands

| Command | What It Does | Sales Value |
| --- | --- | --- |
| `ping` | Plays audio tone | "Is the device responsive?" |
| `locate` | Audible beacon | "Find the device in a warehouse" |
| `play_melody` | Specific audio | "Confirm receipt/delivery" |
| `set_volume` | Adjust audio | "Remote configuration" |

**Command acknowledgment**: Device sends `command_ack.qo` confirming execution.

**DEMO**: Send `locate` command from dashboard → hear device beep.

---

### Slide 14: Remote Configuration via Environment Variables

**No firmware update needed to change behavior.**

**Notehub UI or API**:
```
PUT /v1/projects/{uid}/devices/{uid}/environment_variables
{"mode": "transit", "temp_alert_high_c": 30}
```

**Device reads with**:
```json
{"req": "env.get", "name": "mode"}
```

**Efficient polling**:
```json
{"req": "env.modified"}  // Returns timestamp—only fetch if changed
```

**Songbird uses 20+ environment variables**:
- Operating mode (demo/transit/storage/sleep)
- Alert thresholds (temp, humidity, voltage)
- GPS settings (interval, power save timeout)
- Audio settings (volume, enabled)
- Motion sensitivity

**DEMO**: Change temperature threshold in Notehub UI → device applies immediately.

---

## SECTION 5: OVER-THE-AIR FIRMWARE UPDATES

### Slide 15: OTA Without a Bootloader

**Traditional OTA**:
- Custom bootloader (1,000-2,000 lines)
- Dual partition scheme
- Integrity verification
- Rollback logic
- Update coordination

**Blues Notecard**:
```json
{"req": "card.dfu", "name": "stm32", "mode": "altdfu", "on": true}
```

**Notecard handles everything**:
1. Download firmware from Notehub (background)
2. Verify integrity (MD5)
3. Enter bootloader mode
4. Flash host MCU using ROM bootloader
5. Reboot

**No bootloader code in your firmware.**

---

### Slide 16: Fleet-Wide Firmware Management

**Notehub UI**:
- Upload firmware binary
- Target fleet or individual device
- Monitor rollout progress
- Cancel if issues detected

**API for automation**:
```
POST /v1/projects/{uid}/dfu/host/update?fleetUID={fleet}
GET /v1/projects/{uid}/dfu/host/status
```

**DEMO**: Show firmware page in Songbird dashboard.

---

## SECTION 6: DATA OPTIMIZATION

### Slide 17: Templates = 80% Bandwidth Savings

**Problem**: JSON is verbose. Cellular data is expensive.

**Solution**: Note templates define schema once, Notecard sends compact binary.

**Define template (once at boot)**:
```json
{
  "req": "note.template",
  "file": "track.qo",
  "format": "compact",
  "body": {
    "temp": 14.1,
    "humidity": 14.1,
    "pressure": 14.1,
    "motion": true
  }
}
```
*(Numbers indicate type: 14.1 = float32)*

**Send data (every time)**:
```json
{
  "req": "note.add",
  "file": "track.qo",
  "body": {"temp": 22.5, "humidity": 45.2, "pressure": 1013.25, "motion": true}
}
```

**Over-the-air**: Compact binary (~20 bytes vs ~150 bytes JSON)

**Developer still uses JSON. Notecard handles optimization.**

---

### Slide 18: Bandwidth Impact

| Scenario | JSON Size | Template Size | Savings |
| --- | --- | --- | --- |
| Sensor reading | 150 bytes | 20 bytes | 87% |
| GPS track point | 200 bytes | 32 bytes | 84% |
| Alert | 180 bytes | 24 bytes | 87% |

**At scale**:
- 1,000 devices
- 24 readings/day
- 30 days/month

**JSON**: 108 MB/month
**Templates**: 14 MB/month

**Savings**: 94 MB/month = significant cost reduction

---

## SECTION 7: POWER MANAGEMENT

### Slide 19: Sub-10μA Sleep Mode

**ATTN Pin Magic**:
```json
{
  "req": "card.attn",
  "mode": "sleep,motion,files",
  "files": ["command.qi"],
  "seconds": 3600
}
```

**What happens**:
1. Notecard pulls ATTN pin low
2. Notecarrier cuts power to host MCU
3. Host MCU completely off (0μA)
4. Notecard in standby (~8μA)
5. Notecard wakes host on: timer, motion, or inbound command

**State preservation**: Notecard stores MCU state in `payload` field—restored on wake.

**No RTC, no wake circuits, no complex state machines.**

---

### Slide 20: Built-in Battery Monitoring

```json
{"req": "card.voltage", "mode": "lipo", "alert": true, "sync": true}
```

**Notecard provides**:
- Accurate battery % (LiPo discharge curve)
- USB vs battery detection
- Automatic low-battery alerts
- Alert sync before battery dies

**No ADC, no voltage divider, no firmware battery curves.**

---

### Slide 21: Built-in Motion Detection

```json
{"req": "card.motion.mode", "sensitivity": 1.5}
{"req": "card.motion"}  // Returns {"motion": true/false}
```

**Use cases**:
- Wake on movement
- Motion alerts
- Activity detection
- Theft detection

**No external accelerometer needed.**

---

## SECTION 8: FLEET MANAGEMENT AT SCALE

### Slide 22: Notehub Dashboard

**Live demo of Notehub UI**:
- Device list with status
- Real-time events
- Environment variable editor
- Route configuration
- Fleet organization

**DEMO**: Navigate Notehub showing Songbird devices.

---

### Slide 23: Event Routing

**Notehub routes data anywhere**:
- HTTP webhooks (to your backend)
- AWS IoT Core
- Azure IoT Hub
- Google Cloud IoT
- MQTT brokers
- Custom transformations

**Songbird flow**:
```
Device → Notehub → HTTP Route → AWS Lambda → DynamoDB → Dashboard
```

**DEMO**: Show route configuration in Notehub.

---

### Slide 24: Fleet Defaults

**Set once, apply to all devices**:
```
PUT /v1/projects/{uid}/fleets/{uid}/environment_variables
{"mode": "transit", "sync_interval_min": 15}
```

**Device inheritance**: Fleet defaults → Device overrides

**Scale**: Configure 10,000 devices with one API call.

---

### Slide 25: Notecard Swapping

**Problem**: Hardware fails. Notecard needs replacement.

**Solution**: Serial number stays with device, not Notecard.

**Songbird implementation**:
- Device has stable serial number (e.g., `songbird01-bds`)
- Dashboard tracks serial → Notecard UID mapping
- Replace Notecard → historical data preserved
- Activity feed logs the swap

**Operational simplicity**: Field tech swaps Notecard, done.

---

## SECTION 9: COMPETITIVE ADVANTAGES

### Slide 26: Blues vs. Alternatives

| Capability | Blues Notecard | Particle | AWS IoT + Modem |
| --- | --- | --- | --- |
| Cellular + GPS | Built-in | Separate tracker | You build |
| Autonomous tracking | Yes (MCU sleeps) | MCU required | You build |
| Templates (compression) | 80% savings | No | You build |
| OTA updates | Built-in, no bootloader | Requires bootloader | You build |
| Time to production | Weeks | Months | 6-12 months |
| Lines of code | ~1,000 app code | ~3,000+ | ~7,000+ |

---

### Slide 27: Total Cost of Ownership

**Hardware**:
- Notecard ($49) includes: cellular modem, GPS, accelerometer, antenna, SIM
- Equivalent discrete components: $60-100 + engineering time

**Data**:
- 500 MB included (10-year prepaid)
- Templates reduce consumption 80%
- No per-device monthly fees

**Development**:
- JSON API = any developer can use it
- No cellular expertise required
- Reference designs available

---

## SECTION 10: SUMMARY & CALL TO ACTION

### Slide 28: What We Demonstrated

1. **Zero-config cellular** — One API call, Notecard handles the rest
2. **Built-in GPS** — No external module, no NMEA parsing
3. **Autonomous tracking** — MCU can sleep, Notecard logs position
4. **Cloud commands** — Bidirectional without MQTT complexity
5. **Remote configuration** — Change behavior without firmware updates
6. **OTA updates** — No bootloader code required
7. **Data optimization** — 80%+ bandwidth savings automatically
8. **Power management** — Sub-10μA sleep, built-in battery monitoring
9. **Fleet management** — Scale from 1 to 10,000 devices easily

---

### Slide 29: Getting Started

**For Customers**:
1. Order Notecard Starter Kit ($99)
2. Follow quickstart guide (30 minutes)
3. See data in Notehub
4. Build your application

**Resources**:
- dev.blues.io — Documentation
- discuss.blues.io — Community
- github.com/blues — Open source libraries

**Songbird**:
- Full source code available
- Reference architecture
- Copy patterns for your project

---

### Slide 30: Questions?

**Contact**:
- [Sales contact info]
- [FAE contact info]

**Demo Songbird device available**

---

## Appendix A: Notecard JSON API Reference

### Core APIs Used in Songbird

| API | Purpose |
| --- | --- |
| `hub.set` | Configure product & sync mode |
| `hub.sync` | Force immediate sync |
| `note.template` | Define data schema for compression |
| `note.add` | Send data to cloud |
| `note.get` | Receive inbound commands |
| `card.location.mode` | Configure GPS |
| `card.location.track` | Enable autonomous tracking |
| `card.triangulate` | Enable cell/WiFi location |
| `card.voltage` | Battery monitoring |
| `card.motion` | Motion detection |
| `card.attn` | Sleep with wake conditions |
| `card.dfu` | Enable OTA updates |
| `env.get` | Read configuration variable |
| `env.modified` | Check for config changes |

---

## Appendix B: Notehub API Reference

### APIs Used by Songbird Dashboard

| Endpoint | Purpose |
| --- | --- |
| `GET /projects/{uid}` | Project info |
| `GET /projects/{uid}/devices` | Device list |
| `GET /devices/{uid}/environment_variables` | Device config |
| `PUT /devices/{uid}/environment_variables` | Update config |
| `PUT /fleets/{uid}/environment_variables` | Fleet defaults |
| `POST /devices/{uid}/notes/command.qi` | Send command |
| `GET /firmware?firmwareType=host` | List firmware |
| `POST /dfu/host/update` | Queue OTA update |
| `GET /dfu/host/status` | Update status |

---

## Appendix C: Songbird Feature → Blues Capability Mapping

| Songbird Feature | Notecard API | Notehub Feature |
| --- | --- | --- |
| Real-time location | `card.location`, `card.triangulate` | Event routing |
| GPS tracking | `card.location.track` | `_track.qo` events |
| Temperature alerts | `note.add` to `alert.qo` | HTTP route → SNS |
| Remote commands | `note.get` from `command.qi` | Notes API |
| Mode switching | `env.get` | Environment variables |
| Battery monitoring | `card.voltage` | `_health.qo` events |
| Motion detection | `card.motion` | Wake triggers |
| Firmware updates | `card.dfu` | DFU management |
| Data efficiency | `note.template` | Automatic |
| Sleep mode | `card.attn` | N/A (device-side) |

---

*Document Version: 1.0*
*Last Updated: January 2025*
