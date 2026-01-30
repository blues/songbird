---
planStatus:
  planId: plan-journey-direct-linking
  title: Direct Link to Journey View
  status: completed
  planType: feature
  priority: medium
  owner: satch
  tags:
    - dashboard
    - sharing
    - routing
    - journeys
  created: "2025-01-30"
  updated: "2025-01-30T19:52:00.000Z"
  progress: 100
---
# Direct Link to Journey View

## Goals
- Enable sharing journey views via URL
- Preserve selected journey across page refresh
- Support deep linking for demos and collaboration

## Overview

Currently, journey selection is managed via component-level React state (`selectedJourneyId` in DeviceDetail.tsx). When a user selects a journey, the URL remains `/devices/{serialNumber}` with no indication of which journey is being viewed. This means:
- Links cannot be shared to specific journeys
- Page refresh loses the journey selection
- Cannot bookmark a specific journey view

## Proposed URL Structure

**Option A: Query Parameter (Recommended)**
```
/devices/{serialNumber}?journey={journeyId}
```
Example: `/devices/songbird01-bds?journey=1706745600000`

**Option B: Nested Route**
```
/devices/{serialNumber}/journey/{journeyId}
```
Example: `/devices/songbird01-bds/journey/1706745600000`

**Recommendation:** Option A (query parameter) is simpler and doesn't require route changes. The journey view is conceptually a "mode" of the device detail page rather than a separate entity.

## Implementation Details

### Files to Modify

1. **`src/pages/DeviceDetail.tsx`**
  - Read `journey` query param on mount using `useSearchParams()`
  - Initialize `selectedJourneyId` from URL if present
  - Update URL when journey is selected/deselected
  - Switch to "Journeys" tab automatically when journey param is present

2. **`src/components/journeys/JourneySelector.tsx`** (optional)
  - Add "Copy Link" button for selected journey

### Code Changes

```typescript
// DeviceDetail.tsx
import { useSearchParams } from 'react-router-dom';

// Inside component:
const [searchParams, setSearchParams] = useSearchParams();
const journeyIdFromUrl = searchParams.get('journey');

// Initialize state from URL
const [selectedJourneyId, setSelectedJourneyId] = useState<number | null>(
  journeyIdFromUrl ? parseInt(journeyIdFromUrl, 10) : null
);

// Update URL when journey changes
const handleJourneySelect = (journeyId: number | null) => {
  setSelectedJourneyId(journeyId);
  if (journeyId) {
    setSearchParams({ journey: journeyId.toString() });
  } else {
    searchParams.delete('journey');
    setSearchParams(searchParams);
  }
};

// Auto-switch to journeys tab when journey param present
useEffect(() => {
  if (journeyIdFromUrl && locationTab !== 'journeys') {
    setLocationTab('journeys');
  }
}, [journeyIdFromUrl]);
```

### Edge Cases to Handle

1. **Invalid journey ID in URL**: If the journey doesn't exist for this device, clear the param and show the default view
2. **Journey deleted while viewing**: Already handled - clears selection
3. **Device doesn't exist**: Let existing 404 handling work

## Acceptance Criteria

- [ ] Journey ID appears in URL when a journey is selected
- [ ] Direct link to journey URL loads the correct journey view
- [ ] Page refresh preserves the selected journey
- [ ] Deselecting journey removes the query param
- [ ] Invalid journey IDs are handled gracefully (cleared from URL)
- [ ] "Journeys" tab auto-selected when journey param present
- [ ] (Optional) "Copy Link" button in journey selector

## Testing

1. Select a journey, verify URL updates
2. Copy URL, open in new tab, verify journey loads
3. Refresh page, verify journey still selected
4. Test with invalid journey ID (should clear and show default)
5. Test clicking "Clear" or selecting different journey
