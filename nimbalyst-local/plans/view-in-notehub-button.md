---
planStatus:
  planId: plan-view-in-notehub-button
  title: Add View in Notehub Button to Device Page
  status: completed
  planType: feature
  priority: low
  owner: developer
  tags:
    - dashboard
    - device-detail
    - notehub
    - ui
  created: "2026-02-03"
  updated: "2026-02-03T18:50:00.000Z"
  progress: 100
---
# Add View in Notehub Button to Device Page

## Goals
- Add a "View in Notehub" button to the single device view page
- Button should link directly to the device's page in Notehub
- Position button next to the existing "Config" button

## Overview

Users sometimes need to access the Notehub console to perform advanced operations or view raw device data. Currently, they must manually navigate to Notehub and find the device. This feature adds a convenient deep link directly from the device detail page.

## Implementation Details

### URL Format

The Notehub device URL follows this pattern:
```
https://notehub.io/project/app:b5b8fc4a-d8ca-4bd8-84ad-39563006635d/devices/{deviceUID}
```

Where `{deviceUID}` is the Device UID (e.g., `dev:868531061599986`).

### Frontend Changes

**File:** `songbird-dashboard/src/pages/DeviceDetail.tsx`

1. Add "View in Notehub" button next to the "Config" button
2. Construct the Notehub URL using the device's UID
3. Open link in new tab (`target="_blank"`, `rel="noopener noreferrer"`)
4. Use an external link icon to indicate it opens externally

### Configuration

The Notehub project ID (`app:b5b8fc4a-d8ca-4bd8-84ad-39563006635d`) should be:
- Stored in `public/config.json` for configurability, OR
- Hard-coded if this is a single-project deployment

## Acceptance Criteria

- [x] "View in Notehub" button appears on device detail page
- [x] Button is positioned next to the "Config" button
- [x] Clicking the button opens Notehub device page in a new tab
- [x] URL correctly includes the device's UID
- [x] Button has appropriate icon indicating external link
