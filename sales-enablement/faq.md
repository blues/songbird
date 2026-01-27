# Songbird Demo FAQ
## Common Questions from Customers and Prospects

---

## About Songbird

### What is Songbird?

Songbird is Blues' internal sales demonstration platform. It's a real working IoT device that showcases all the capabilities of Notecard and Notehub. Everything Songbird does is powered by the same products customers can buy.

**Songbird is NOT a product we sell.** It's a reference implementation that demonstrates what's possible with Blues.

### Can customers buy Songbird?

No. Songbird is a demo tool, not a commercial product. However:
- Songbird source code is available as a reference architecture
- Customers can copy patterns, code, and approaches directly
- The components (Notecard, Notecarrier CX, Mojo) are all available for purchase, while the sensors are available from SparkFun.

### What hardware is inside Songbird?

| Component | Purpose |
|-----------|---------|
| Blues Notecard (WBGLW) | Cellular, GPS, accelerometer |
| Notecarrier CX with onboard STM32L433 MCU | Application processor |
| BME280 Sensor | Temperature, humidity, pressure |
| Panel Mount button | Locking Transit and Demo modes |
| Qwiic Buzzer | Audio feedback |
| LiPo Battery | Portable power |

---

## Notecard Questions

### What is Notecard?

Notecard is a system-on-module that provides cellular connectivity, GPS, and an accelerometer in a single device. It communicates with a host microcontroller via I2C using simple JSON commands.

**Key differentiator:** Notecard handles all cellular complexity (modem drivers, AT commands, APN config, certificates) so developers just send JSON.

### What's included with the Notecard cellular data?

- 500MB prepaid data
- 10-year validity
- Global coverage (140+ countries, 140+ carriers)
- No monthly fees
- No carrier contracts

After 500MB, purchase additional data through Notehub.

### Can I use my own SIM card?

Yes. Notecard supports external SIM for:
- Specific carrier requirements
- Private APNs
- Regions where built-in SIM isn't optimal

However, the built-in SIM works in most cases and is simpler.

### How accurate is the GPS?

| Condition | Accuracy |
|-----------|----------|
| Clear sky, good signal | 2-5 meters |
| Urban canyon | 5-15 meters |
| Near buildings | 10-30 meters |
| Indoor | GPS doesn't work (use triangulation) |

Notecard reports DOP (Dilution of Precision) so you know the quality of each fix.

### How long does GPS take to get a fix?

| Scenario | Time |
|----------|------|
| Cold start (first fix) | 30-60 seconds |
| Warm start (recent fix) | 5-10 seconds |
| Assisted GPS | 5-15 seconds |

Notecard uses cellular-assisted GPS to speed acquisition.

### Does GPS work indoors?

No. GPS requires line-of-sight to satellites.

For indoor location, use triangulation:
- Cell tower triangulation: ~500m-2km accuracy
- WiFi triangulation: ~50-200m accuracy

Songbird Demo mode uses triangulation by default so it works indoors.

### What's "autonomous tracking"?

Autonomous tracking is Notecard's killer feature for asset tracking:

1. Host MCU can be completely powered off
2. Notecard monitors for motion using built-in accelerometer
3. When motion detected, Notecard wakes GPS
4. Captures position, velocity, bearing
5. Stores data in local buffer
6. Syncs to cloud on schedule

**Benefit:** 10x+ battery life vs. keeping MCU awake for GPS.

---

## Notehub Questions

### What is Notehub?

Notehub is Blues' cloud service that:
- Receives data from Notecards
- Routes data to your backend (AWS, Azure, webhooks, etc.)
- Provides device management (configuration, OTA updates)

### Is Notehub required?

Yes. Notecard communicates exclusively with Notehub. This provides:
- Consistent security model
- Simplified device provisioning
- Central management plane

However, you can route data anywhere from Notehub - there's no lock-in on your backend.

### How much does Notehub cost?

| Tier | Price | Included |
|------|-------|----------|
| Free | $0 | 5,000 events/month per Billing Account |
| Essentials | $0.00075/event | Unlimited, fixed price |
| Enterprise | Custom | SLA, support, features |

Most demos/prototypes fit in the free tier.

### Can I self-host Notehub?

Not currently. Notehub is a managed service only.

However, for high-security scale applications, Blues can offer:
- Dedicated Notehub instances
- Private routes (VPC peering)
- Custom data residency

### How do I get data from Notehub to my system?

Notehub routes data via:
- **HTTP webhooks** - Most common, works with any backend
- **AWS IoT Core** - Direct integration
- **Azure IoT Hub** - Direct integration
- **MQTT** - Any broker
- **Custom integrations** - Slack, email, etc.

Multiple routes can run simultaneously.

---

## Power & Battery Questions

### What's the battery life?

Battery life depends entirely on use case:

| Use Case | Sync Interval | Battery Life (2000mAh) |
|----------|---------------|------------------------|
| Continuous monitoring | Every minute | 2-5 days |
| Periodic check-in | Every hour | 2-4 weeks |
| Motion-triggered only | On movement | 2-6 months |
| Deep sleep | Manual wake | 6-12+ months |

Songbird demonstrates these trade-offs through its different modes.

### What's the power consumption?

| State | Current Draw |
|-------|--------------|
| Deep sleep (Notecard only) | ~8-12 microamps |
| Idle (MCU awake) | ~5 milliamps |
| Cellular transmit | ~200-500 milliamps |
| GPS acquisition | ~30-50 milliamps |

### What battery voltages does Notecard support?

- **Input range:** 3.3V - 5.5V
- **Ideal:** Single-cell LiPo (3.7V nominal)
- **Notecarrier provides:** LiPo charging, fuel gauge, power path

### How does Notecard handle low battery?

1. Monitors battery voltage continuously
2. Generates alert when below threshold
3. Syncs alert immediately (before battery dies)
4. Can automatically enter low-power mode

---

## Security Questions

### Can someone intercept Notecard communications?

No. All communication is encrypted via TLS. Even if someone intercepts the cellular traffic, they cannot read the payload.

### How are devices authenticated?

Each Notecard has a unique, factory-provisioned identity. When a Notecard connects to Notehub:
1. Mutual TLS authentication
2. Device identity verified against Notehub records
3. Project association confirmed

No passwords, API keys, or certificates to manage.

### What about firmware security?

- Firmware is signed and verified
- OTA updates use secure download
- Rollback protection available
- No unsigned code execution

---

## Competitive Questions

### How does Blues compare to Particle?

| Feature | Blues | Particle |
|---------|-------|----------|
| Autonomous GPS tracking | Yes - MCU can sleep | No - MCU must be awake |
| Asset tracking battery life | Months | Days |
| Pricing model | Per-consumption | Per-device monthly |
| Connectivity | Cellular focus | Cellular + WiFi + Mesh |

**Best talking point:** For asset tracking, Particle Tracker requires the MCU to stay awake for GPS. Notecard tracks autonomously with the MCU powered off - 10x+ battery improvement.

### How does Blues compare to AWS IoT?

AWS IoT provides cloud infrastructure. Blues provides the on-device experience.

With AWS IoT alone, you still need:
- Modem driver code
- GPS parsing code
- Power management
- OTA bootloader
- Certificate provisioning

Blues handles all of this, and routes data to AWS IoT.

**Best talking point:** Blues and AWS are complementary. Notecard handles device complexity, AWS handles cloud complexity.

### How does Blues compare to Hologram?

Hologram is SIM/connectivity only. Blues is a full system-on-module.

| Feature | Blues | Hologram |
|---------|-------|----------|
| Cellular connectivity | Yes | Yes |
| Built-in GPS | Yes | No |
| Built-in accelerometer | Yes | No |
| OTA updates | Yes | No |
| Data templates | Yes | No |

**Best talking point:** Hologram provides great connectivity, but you'd need to source and integrate GPS, accelerometer, and build OTA yourself. Blues provides it all in one module.

### How does Blues compare to building our own?

Building cellular IoT from scratch requires:
- Selecting a modem (~$20-50)
- Writing modem driver (1-2 months)
- Carrier certification (3-6 months, $10k+)
- GPS module + integration
- Power management design
- OTA bootloader (1-2 months)
- Security/certificate management

Blues eliminates all of this. Time to first data: 30 minutes.

**Best talking point:** Blues lets you skip the cellular learning curve. Your team focuses on the application, not connectivity plumbing.

---

## Pricing Questions

### What's the total cost of ownership?

**Hardware (one-time):**
- Notecard: $49
- Notecarrier: $25 (dev) or $0 (custom PCB)
- Your MCU: varies

**Data (as you go):**
- First 500MB: included
- Additional: Connectivity Assurance available (see blues.com)

**Cloud (per event):**
- First 5,000/month: free
- Additional: $0.00075/event (or cheaper with volume agreements)

**Example:** A device sending 24 sensor readings/day uses ~1MB/month and 720 events/month. After initial 500MB, annual cost is ~$3/year in data and free tier covers events.

### Are there monthly fees?

No monthly per-device fees. Blues uses consumption-based pricing:
- Pay for data used
- Pay for events routed
- No minimums, no contracts

---

## Development Questions

### How long does integration take?

| Milestone | Typical Time |
|-----------|--------------|
| First data to cloud | 30 minutes |
| Basic prototype | 1-2 days |
| Production firmware | 2-4 weeks |
| Full product | 2-3 months |

Compare to traditional cellular: 6-12 months to production.

### What MCUs work with Notecard?

Any MCU with I2C support:
- Arduino (all variants)
- ESP32
- STM32
- Raspberry Pi
- Nordic nRF
- Many more

Notecard is MCU-agnostic - if it can send strings over I2C or Serial, it works.

### Is there an SDK?

Yes, open-source SDKs available:
- **note-c** - Pure C, any platform
- **note-arduino** - Arduino library
- **note-python** - Python/CircuitPython
- **note-zephyr** - ZephyrRTOS
- **note-esp** - esp-idf support
- **note-go** - Go language

But you don't need an SDK - Notecard accepts raw JSON commands.

### Where's the documentation?

**Main developer portal:** [dev.blues.io](https://dev.blues.io)
- API reference
- Tutorials
- Hardware guides
- Sample code

**Songbird source code:** Available as reference architecture at https://github.com/blues/songbird.

---

## Demo-Specific Questions

### Why does location show wrong in the demo?

Songbird Demo mode uses triangulation (cell tower/WiFi) instead of GPS. Triangulation accuracy is 100-500m, not GPS-level precision.

This is intentional - it lets us demo indoors without waiting for GPS lock.

For GPS precision demos, use Transit mode outdoors.

### Why is there a delay in commands?

Command latency depends on mode:

| Mode | Polling Interval | Typical Latency |
|------|------------------|-----------------|
| Demo | 1 second | 1-3 seconds |
| Transit | 15 minutes | Up to 15 minutes |
| Storage | 60 minutes | Up to 60 minutes |

Demo mode should have near-instant response. If delays persist, verify the device is in Demo mode.

### Can I show this to a customer?

Yes! Songbird is designed for customer demos. You can:
- Let customers hold the device
- Show them the dashboard
- Show them Notehub
- Share the architecture
- Point them to the GitHub repo

You cannot share:
- API tokens
- Internal documentation

---

## Next Steps Questions

### How can a customer evaluate Blues?

1. **Notecard Starter Kit** - $79-99, everything needed
2. **Online simulator** - dev.blues.io/notecard-simulator

### What support is available?

| Resource | Access |
|----------|--------|
| Documentation | Public, dev.blues.io |
| Community forum | Public, discuss.blues.io |
| GitHub issues | Public |
| Email support | Customers |
| Dedicated support | Enterprise tier |

---

*Document Version: 1.0*
*Last Updated: January 2025*
