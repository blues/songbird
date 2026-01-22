---
planStatus:
  planId: plan-city-level-visited-locations-map
  title: City-Level Visited Locations Map
  status: completed
  planType: feature
  priority: medium
  owner: developer
  tags:
    - dashboard
    - map
    - visualization
    - telemetry
  created: "2026-01-21"
  updated: "2026-01-21T18:30:00.000Z"
  progress: 100
---
# City-Level Visited Locations Map

## Goals
- Display all unique cities a device has visited on an interactive map
- Aggregate location history data to city-level granularity
- Provide a visual summary of device travel patterns

## Overview

Create a new map component that shows the unique locations a device has visited, aggregated at the city level. Instead of showing every individual GPS point or location update, this component will cluster locations by city and display a single marker per city visited.

## Technical Approach: Backend Aggregation

Create a new API endpoint to aggregate locations server-side, providing access to complete historical data.

### Backend Implementation

**New Lambda**: `lambda/api-visited-cities/index.ts`

**Endpoint**: `GET /v1/devices/{serialNumber}/visited-cities`

**Query Parameters**:
- `from` (optional): Start timestamp (ISO 8601)
- `to` (optional): End timestamp (ISO 8601)
- Default: All historical data

**Response**:
```typescript
interface VisitedCitiesResponse {
  cities: VisitedCity[];
  totalLocations: number;
  dateRange: {
    from: string;
    to: string;
  };
}

interface VisitedCity {
  cityName: string;
  state?: string;
  country?: string;
  latitude: number;
  longitude: number;
  visitCount: number;
  firstVisit: string;
  lastVisit: string;
}
```

**Implementation Steps**:

1. **Query Telemetry Table**: Fetch all location records for the device
  - Use GSI on `device_serial` + `time` for efficient querying
  - Filter to records with `location_name` present

2. **Aggregate by City**: Group records by normalized city name
  - Parse `location_name` to extract city (first comma-separated segment)
  - Normalize: lowercase, trim whitespace
  - Track: count, first/last timestamps, representative coordinates

3. **Return Summary**: Return deduplicated city list with metadata

### Infrastructure Changes

**Files to modify**:
- `lib/api-construct.ts`: Add new route and Lambda
- `lib/songbird-stack.ts`: Wire up permissions

**New files**:
- `lambda/api-visited-cities/index.ts`: Lambda handler

## Implementation Details

### New Component: `VisitedCitiesMap`

Location: `src/components/maps/VisitedCitiesMap.tsx`

```typescript
interface VisitedCity {
  cityName: string;
  state?: string;
  country?: string;
  latitude: number;
  longitude: number;
  visitCount: number;
  firstVisit: string;
  lastVisit: string;
}

interface VisitedCitiesMapProps {
  serialNumber: string;
  hours?: number;  // Time range to aggregate
  mapboxToken: string;
}
```

**Features:**
- Interactive Mapbox GL map (consistent with existing maps)
- City markers with visit count badges
- Popup on click showing:
  - City name
  - Total visits
  - First visit date
  - Last visit date
- Respects user's map style preference (street/satellite)
- Auto-fits bounds to show all visited cities

### City Extraction Logic (Backend)

Parse `location_name` in Lambda to extract city:
- Handle formats: "Austin, TX", "Austin, Texas, USA", etc.
- Use first comma-separated segment as city name
- Normalize: lowercase, trim for grouping key
- Return original casing for display
- Skip records with missing `location_name`

### Integration Points

1. **Device Detail Page**: Add as a new tab or section
2. **Standalone Page**: Create `/devices/:serialNumber/visited-cities` route
3. **Fleet View**: Optional aggregate view showing all cities visited by any device

## UI/UX Considerations

- **Marker Design**: Distinct from journey/location markers (perhaps a different color/icon)
- **Visit Count Badge**: Small number badge on marker showing visit count
- **Popup Content**:
  - City, State name
  - "Visited X times"
  - "First visit: [date]"
  - "Last visit: [date]"
- **List View Toggle**: Option to switch between map and list view of visited cities
- **Time Range Selector**: Allow filtering by time range (24h, 7d, 30d, all time)

## File Structure

**Backend (songbird-infrastructure)**:
```
lambda/
├── api-visited-cities/
│   └── index.ts (new)
lib/
├── api-construct.ts (modify - add route)
```

**Frontend (songbird-dashboard)**:
```
src/api/
└── visitedCities.ts (new - API client)

src/hooks/
└── useVisitedCities.ts (new - React Query hook)

src/components/maps/
├── FleetMap.tsx (existing)
├── LocationTrail.tsx (existing)
└── VisitedCitiesMap.tsx (new)

src/types/
└── index.ts (modify - add types)
```

## Dependencies

**Backend**:
- Existing: AWS SDK, DynamoDB client
- No new dependencies

**Frontend**:
- Existing: react-map-gl, mapbox-gl, @tanstack/react-query
- No new dependencies

## Acceptance Criteria

### Backend
- [x] New Lambda function `api-visited-cities` created
- [x] API endpoint `GET /v1/devices/{serialNumber}/visited-cities` working
- [x] Queries all historical location data for device
- [x] Correctly aggregates locations by city name
- [x] Returns visit count, first/last visit timestamps per city
- [x] Optional date range filtering via query params

### Frontend
- [x] API client function for visited cities endpoint
- [x] React Query hook `useVisitedCities`
- [x] New `VisitedCitiesMap` component created
- [x] Map displays unique city markers with visit counts
- [x] Clicking marker shows popup with city details
- [x] Map auto-fits to show all visited cities
- [x] Respects user map style preference
- [x] Handles edge cases (no data, single city)
- [x] Mobile responsive design
- [x] Integrated into Device Detail page

## Future Enhancements

- Heatmap visualization option
- Export visited cities as CSV/JSON
- Fleet-wide visited cities view (all devices)
- Time-lapse animation showing visit progression
