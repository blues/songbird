---
planStatus:
  planId: plan-public-device-view
  title: Public Device View for Unauthenticated Users
  status: in-development
  planType: feature
  priority: medium
  owner: developer
  tags:
    - authentication
    - public-access
    - device-view
    - sharing
  created: "2026-01-11"
  updated: "2026-01-11T19:30:00.000Z"
  progress: 100
---

# Public Device View for Unauthenticated Users

## Goals
- Allow unauthenticated users to view a single device via direct URL
- Show full navigation for authenticated users viewing the same URL
- Show minimal UI (device view only, no navigation) for unauthenticated users
- Enable easy device sharing for demos and customer presentations

## Overview

Currently, all device views require authentication. For sales demos and customer presentations, it would be useful to share a direct link to a device's information without requiring the viewer to log in. This feature will create a public route that conditionally renders navigation based on authentication state.

## Implementation Details

### URL Structure
- Public route: `/public/device/:serialNumber`

### Frontend Changes

1. **New Public Device Route**
   - Create a new route that doesn't require authentication
   - Conditionally render navigation based on auth state
   - Reuse existing DeviceDetail component

2. **Layout Modifications**
   - Create a minimal layout wrapper for unauthenticated views
   - Hide sidebar/navigation for unauthenticated users
   - Show "Sign in" link/button for unauthenticated users

3. **Auth Context Updates**
   - Ensure auth context handles unauthenticated state gracefully
   - Don't redirect to login for public routes

### Backend Changes

1. **New Public API Endpoint**
   - `GET /public/devices/:serialNumber` - Returns full device info without auth
   - Returns all device data in read-only form

2. **Audit Logging**
   - Log all public device access requests
   - Include: serial number, timestamp, IP address, user agent

### Security Considerations
- Rate limiting on public endpoints to prevent abuse
- Audit logging for all public access

## Acceptance Criteria
- [x] Unauthenticated users can view device info via direct URL
- [x] Authenticated users see full navigation on the same URL (redirects to /devices/:serialNumber)
- [x] Unauthenticated users see device view without navigation
- [x] Unauthenticated users see a "Sign in" option
- [x] Public endpoint returns full device data
- [x] Public access is audit logged
- [x] Existing authenticated routes continue to work normally

## Implementation Summary

### Files Created

**Backend (songbird-infrastructure):**
- `lambda/api-public-device/index.ts` - Public device Lambda handler with audit logging
- Updated `lib/storage-construct.ts` - Added `auditTable` for audit logs
- Updated `lib/api-construct.ts` - Added public device Lambda and route
- Updated `lib/songbird-stack.ts` - Pass audit table to API construct

**Frontend (songbird-dashboard):**
- `src/pages/PublicDeviceView.tsx` - Public device view page with minimal layout
- Updated `src/api/devices.ts` - Added `getPublicDevice()` function
- Updated `src/App.tsx` - Added public route outside Authenticator wrapper

### API Endpoint
- `GET /v1/public/devices/{serial_number}` - No authentication required
- Returns device info + 24h telemetry history
- All access logged to `songbird-audit` DynamoDB table

### Frontend Route
- `/public/device/:serialNumber` - Public device view
- Shows: current readings, location map, 24h telemetry chart, device info
- Includes "Sign In" button for users who want full access

### Deployment Steps
1. Deploy infrastructure: `cd songbird-infrastructure && npm run deploy`
2. Build dashboard: `cd songbird-dashboard && npm run build`
3. Deploy dashboard to S3/CloudFront
