# Songbird Demo Setup Guide
## For Sales & Field Application Engineers

---

## Overview

This guide walks you through setting up Songbird for customer demos. Follow these steps before every demo to ensure a smooth experience.

---

## Quick Start Checklist

Use this checklist 45-60 minutes before your demo:

- [ ] Device powered on and charged (>50% battery)
- [ ] Device in Demo mode
- [ ] Dashboard accessible at `https://songbird.live`
- [ ] Device visible on Fleet Map with green status
- [ ] Audio working (send test locate command)
- [ ] Notehub tab open for showing raw events

---

## Device Setup

### 1. Charge the Device

Songbird uses a rechargeable LiPo battery. Charge via USB-C before demos.

**Check battery level:**
1. Open Songbird dashboard
2. Navigate to your device
3. Look for battery percentage in the device header

**Minimum for demo:** 50% battery
**Recommended:** Fully charged or connected to USB power

### 2. Power On

Songbird is intended to be an "always on" device, and there's no need to power it on. As long as the battery is plugged in, or the Notecarrier CX is plugged in over USB-C, you'll have power, which you can confirm by observing:
- the red LED on the Notecard blinking periodically
- the RED LEDs on the Sparkfun BME and Piezo buzzer steadily illuminated

You can also press the enclosure button, which will trigger a mode lock (Transit or Demo) and play a chime on the buzzer.

Finally, it's also possible to remove the top lid of the Songbird enclosure and press the "RESET" button on the Notecarrier CX (marked "RST").

### 3. Set Demo Mode

Demo mode configures the device for optimal demo experience:
- Immediate sync (no waiting for data)
- 1-second command polling (instant response)
- Triangulation location (works indoors)
- Audio feedback enabled

It's recommended to place your Songbird in Demo mode as a default at least *one hour* prior to a demonstration to ensure that the Notecard receives the change.

**To enable Demo mode:**

**Option A: Dashboard**
1. Go to Device Detail page
2. Click **Configuration** tab
3. Set **Mode** to "Demo"
4. Click **Save**

**Option B: Notehub**
1. Open device in Notehub
2. Go to **Environment** tab
3. Set `mode` = `demo`
4. Click **Save**

**Option C: Demo Lock**
1. Quickly press the button on the side of the Songbird enclosure 4 times to set Demo Lock mode. The button used for Songbird is a latching button, so you'll need to latch and unlatch the button twice (a total of four presses) in order to enable Demo mode.
2. Confirm Demo mode in the Songbird dashboard (may take 2-4 min)

### 4. Set Audio Volume

Ensure the demo audience can hear audio feedback.

**In Dashboard:**
1. Device Detail → Configuration
2. Set **Volume** to 75-100%
3. Save

**Test audio:**
1. Go to Device Detail → Quick Actions
2. Click **Ping**
3. Device should beep within 5 seconds (assuming your device is in Demo mode)

### 5. Verify Connectivity

Confirm the device is online and communicating:

| Check | Where | Expected |
|-------|-------|----------|
| Status indicator | Dashboard header | Green circle |
| Last seen | Device Detail | Within last minute |
| Events flowing | Notehub Events tab | Recent `track.qo` events |

---

## Dashboard Setup

### Access the Dashboard

**URL:** `https://songbird.live`

**Login:**
- Use your Blues email address
- Contact Brandon Satrom if you need account access

### Verify Your Permissions

You can view all devices in the project with basic account access, but you cannot modify device or fleet configuration without an "Admin" account, other than for a device assigned to you.

If you have a device assigned to you, it should show up via a "My Device" link on the left nav in the dashboard. If you don't see this link, contact Brandon Satrom.

For a device assgigned to you, you can change coniguration, send commands, and clear alerts.

### Browser Recommendations

- **Chrome** or **Edge** recommended (best Mapbox performance)
- Enable location services for "current location" features
- Disable popup blockers for Notehub links
- Disbale Ad Blockers (which interfere with usage tracking and feature gating/flag capabilities)

### Screen Sharing Tips

If presenting remotely:
1. Open dashboard in a separate browser window (not tab)
2. Set browser zoom to 100%
3. Close other tabs to reduce clutter
4. Have Notehub ready in a second window

---

## Notehub Setup

### Access Notehub

**URL:** `https://notehub.io`

**Project:** Click the "Songbird" project card. If you do not see this card, contact Brandon Satrom.

### Key Pages to Have Ready

1. **Device Events** - Shows raw JSON events from the device
2. **Device Environment** - Shows/edits environment variables
3. **Routes** - Shows data routing configuration

### API Access (Optional)

If you want to demonstrate API calls:

1. Go to Notehub → Settings → API
2. Copy your API token (keep private!)
3. Use with curl or Postman

Example API call:
```bash
curl -X GET "https://api.notefile.net/v1/projects/app:xxxx/devices" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Mode Reference

Songbird has four operating modes. Use the right mode for your situation:

| Mode | Use Case | Sync Interval | Location | Power |
|------|----------|---------------|----------|-------|
| **Demo** | Customer presentations | Immediate | Triangulation | High |
| **Transit** | Shipping/logistics demos | 15 min | GPS tracking | Medium |
| **Storage** | Warehouse scenarios | 60 min | Triangulation | Low |
| **Sleep** | Battery life demos | On motion | Disabled | Minimal |

### When to Use Each Mode

**Demo Mode** (default for presentations)
- Indoor demos where you need instant response
- Shows cloud-to-device commands working immediately
- Best for real-time interaction

**Transit Mode** (for asset tracking demos)
- Shows autonomous GPS tracking
- Device logs GPS points while MCU sleeps
- Shake device to trigger new GPS point
- Best for "asset in motion" scenarios

**Storage Mode** (for monitoring demos)
- Lower power consumption
- Hourly environmental readings
- Good for "cold chain" scenarios

**Sleep Mode** (for battery life discussions)
- Absolute minimum power
- Only wakes on motion detection
- Use to demonstrate multi-month battery life potential

---

## Troubleshooting

### Device Won't Power On

1. Connect USB-C charger
2. Wait 5 minutes (deeply discharged battery needs time)
3. Once minimally charged, Songbird should appear in the dashboard and report it's battery charge.
4. If still dead, contact Brandon Satrom

### Device Shows Offline

1. **Wait 60 seconds** - Initial connection takes time
2. Check cellular coverage - move near window if needed
3. Remove the cover of the Songbird and press the "RESET" button on the Notecarrier CX
4. Verify mode isn't "Sleep" (very long poll intervals)

### Commands Not Working

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Command sent but no response | Device in non-demo mode | Switch to Demo mode |
| "Locate" sent but no sound | Volume set to 0 | Increase volume in config |
| Command shows "pending" | Device hasn't polled yet | Wait or switch to Demo mode |

### No Location on Map

1. **Indoor?** GPS won't work - ensure Demo mode (uses triangulation)
2. **Outdoor?** Wait 60 seconds for GPS lock
3. **Check Notehub** - Look for `_track.qo` or `_geolocate.qo` events
4. **Reset the Songbird** if no location events appearing

### Dashboard Not Updating

1. Hard refresh: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows)
2. Check "Last seen" timestamp on device
3. Try a different browser
4. Clear browser cache if issues persist

---

## Pre-Demo Checklist (Detailed)

### 1 Hour Before

- [ ] Songbird device charged or charging
- [ ] Login to dashboard works
- [ ] Login to Notehub works
- [ ] Test internet connectivity
- [ ] Set to Demo mode

### 30 Minutes Before

- [ ] Verify device shows online in dashboard
- [ ] Set audio volume to 75%+
- [ ] Test locate command (hear the beep)

### 10 Minutes Before

- [ ] Open dashboard in browser window
- [ ] Open Notehub in separate window
- [ ] Position device where audience can see/hear it
- [ ] Have demo script nearby for reference

### During Demo

- [ ] Confirm events appearing in Notehub
- [ ] Commands executing quickly (Demo mode)
- [ ] Audio audible to audience
- [ ] Dashboard updating in real-time

---

## After the Demo

### Reset Device for Next Demo

1. Keep in Demo mode (or switch to Storage to save battery, or Transit if driving)
2. Plug in USB-C charger
3. Verify device stays online

### Report Issues

If you encountered problems:
1. Note the time and what happened
2. Report via Slack #songbird

### Request New Features

Demo feedback drives product improvements! Share what customers asked about or features that would help close deals in the #songbird channel.

---

## Appendix: Dashboard Navigation

| Page | URL Path | Purpose |
|------|----------|---------|
| Fleet Map | `/map` | Full-screen map of all devices |
| Devices List | `/devices` | Table view of fleet |
| Device Detail | `/devices/{serial}` | Single device deep-dive |
| Alerts | `/alerts` | Temperature/threshold alerts |
| Commands | `/commands` | Fleet-wide command history |
| Settings | `/settings` | User management, fleet config |

---

*Document Version: 1.0*
*Last Updated: January 2025*
