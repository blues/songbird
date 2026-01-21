---
planStatus:
  planId: plan-claimed-devices-view
  title: My Device Navigation Link
  status: completed
  planType: feature
  priority: medium
  owner: developer
  tags:
    - dashboard
    - devices
    - navigation
    - user-experience
  created: "2026-01-21"
  updated: "2026-01-21T19:00:00.000Z"
  progress: 100
---
# My Device Navigation Link

## Goals

- Add a sidebar navigation link that takes users directly to their claimed device
- Conditionally show/hide the link based on whether the user has a claimed device
- Provide one-click access to device details for device owners

## Overview

Users with a claimed device need quick access to their device's detail page. Since each user can only have one claimed device, this feature adds a conditional "My Device" link in the sidebar that navigates directly to the device detail view. If the user has no claimed device, the link is hidden.

## Implementation Details

### Approach

Add a conditional "My Device" navigation item in the sidebar that:
- Only appears if the current user has a claimed device
- Links directly to `/devices/{serialNumber}` (the device detail page)
- No new page needed - leverages existing device detail view

### Files Changed

**New Files:**
- `songbird-dashboard/src/hooks/useMyDevice.ts` - Hook to get current user's claimed device serial number

**Modified Files:**
- `songbird-dashboard/src/components/layout/Sidebar.tsx` - Added conditional "My Device" nav link

### Logic Flow

```
1. useMyDevice hook fetches:
   - Current user's email (from Cognito session)
   - All users with device assignments
   - All devices (to map device_uid → serial_number)
2. Hook finds current user by email match
3. Gets assigned device UID from user.assigned_devices[0]
4. Maps device UID to serial number
5. Returns serialNumber (or null if no device assigned)
6. Sidebar conditionally renders "My Device" link when serialNumber exists
```

## Acceptance Criteria

- [x] "My Device" link appears in sidebar when user has a claimed device
- [x] "My Device" link is hidden when user has no claimed device
- [x] Clicking the link navigates directly to the device detail page
- [x] Link updates if user's claimed device changes (assignment/unassignment)
- [x] Works correctly for all user roles
