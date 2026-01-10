---
planStatus:
  planId: plan-feature-flags-enhancement
  title: PostHog Integration for Analytics & Feature Flags
  status: ready-for-development
  planType: feature
  priority: medium
  owner: developer
  tags:
    - feature-flags
    - analytics
    - posthog
    - dashboard
  created: "2026-01-10"
  updated: "2026-01-10T05:27:20.000Z"
  progress: 0
---
# PostHog Integration for Analytics & Feature Flags

## Goals

- Integrate PostHog for product analytics and feature flag management
- Replace the homegrown feature flag system with PostHog's solution
- Enable user behavior tracking, A/B testing, and remote flag updates
- Maintain backward compatibility during migration

## Why PostHog

PostHog provides a unified platform for analytics and feature flags with a generous free tier:

| Feature | Free Tier |
| --- | --- |
| Analytics events | 1M/month |
| Feature flag requests | 1M/month |
| Session replays | 5K/month |
| Survey responses | 250/month |

**Key Benefits:**
- Remote flag updates without deployment
- A/B testing with automatic analytics tagging
- Percentage-based rollouts
- User targeting and segmentation
- Unified analytics + flags platform
- Self-hosted option available
- Unlimited team seats

---

## Current State

Songbird has a homegrown feature flag system:

**Location:** `songbird-dashboard/src/contexts/FeatureFlagsContext.tsx`

**Current Features:**
- React Context-based state management
- URL parameters (`?ff_analytics=true`)
- localStorage persistence
- Admin panel in Settings
- Single flag: `analytics`

---

## Implementation Plan

### Phase 1: PostHog Setup

**1.1 Create PostHog Account & Project**
- Sign up at posthog.com (or self-host)
- Create a "Songbird" project
- Note API key and host URL

**1.2 Install Dependencies**
```bash
cd songbird-dashboard
npm install posthog-js
```

**1.3 Initialize PostHog Provider**

Update `src/main.tsx`:
```tsx
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'

posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
  api_host: import.meta.env.VITE_POSTHOG_HOST,
  defaults: '2025-11-30',
  feature_flag_request_timeout_ms: 3000,
})

// In render:
<PostHogProvider client={posthog}>
  <App />
</PostHogProvider>
```

**1.4 Add Environment Variables**

Update `.env` and `public/config.json`:
```
VITE_POSTHOG_KEY=phc_xxx
VITE_POSTHOG_HOST=https://app.posthog.com
```

---

### Phase 2: Feature Flag Migration

**2.1 Create Flags in PostHog Dashboard**
- `analytics` - Enable Analytics page
- Add any future flags as needed

**2.2 Create PostHog Feature Flag Hook**

Create `src/hooks/usePostHogFeatureFlags.ts`:
```tsx
import { useFeatureFlagEnabled } from 'posthog-js/react'

export function useFeature(flag: string): boolean {
  return useFeatureFlagEnabled(flag) ?? false
}
```

**2.3 Update Navigation Components**

Modify `Sidebar.tsx` and `MobileNav.tsx` to use PostHog hooks:
```tsx
import { useFeatureFlagEnabled } from 'posthog-js/react'

// Replace homegrown flag check:
const analyticsEnabled = useFeatureFlagEnabled('analytics')
```

**2.4 Update Settings Feature Flags Panel**

Modify `src/components/settings/FeatureFlags.tsx`:
- Show current flag states from PostHog
- Remove local toggle controls (flags managed in PostHog dashboard)
- Add link to PostHog dashboard for admins

---

### Phase 3: Analytics Integration

**3.1 Identify Users**

In `src/contexts/AuthContext.tsx`, identify authenticated users:
```tsx
import posthog from 'posthog-js'

// After successful login:
posthog.identify(user.sub, {
  email: user.email,
  name: user.name,
  group: user['cognito:groups']?.[0],
})
```

**3.2 Track Key Events**

Add event tracking for important actions:
```tsx
// Device viewed
posthog.capture('device_viewed', { deviceId, serialNumber })

// Command sent
posthog.capture('command_sent', { command, deviceId })

// Alert acknowledged
posthog.capture('alert_acknowledged', { alertId })

// Journey played
posthog.capture('journey_played', { journeyId, deviceId })
```

**3.3 Track Page Views**

In `src/App.tsx` or router:
```tsx
import { usePostHog } from 'posthog-js/react'
import { useLocation } from 'react-router-dom'

const location = useLocation()
const posthog = usePostHog()

useEffect(() => {
  posthog.capture('$pageview')
}, [location.pathname])
```

---

### Phase 4: Cleanup

**4.1 Remove Homegrown Implementation**
- Delete `src/contexts/FeatureFlagsContext.tsx`
- Remove `FeatureFlagsProvider` from app
- Update imports throughout codebase

**4.2 Update Documentation**
- Update README with PostHog setup
- Document flag management in PostHog dashboard

---

## File Changes Summary

| File | Action |
| --- | --- |
| `package.json` | Add `posthog-js` |
| `src/main.tsx` | Add `PostHogProvider` |
| `.env` | Add PostHog keys |
| `public/config.json` | Add PostHog config |
| `src/contexts/FeatureFlagsContext.tsx` | Delete |
| `src/components/settings/FeatureFlags.tsx` | Update to read-only |
| `src/components/Sidebar.tsx` | Use PostHog hooks |
| `src/components/MobileNav.tsx` | Use PostHog hooks |
| `src/contexts/AuthContext.tsx` | Add user identification |
| `src/App.tsx` | Add pageview tracking |

---

## Rollback Plan

If issues arise:
1. Keep homegrown `FeatureFlagsContext.tsx` as fallback
2. Feature flag the PostHog integration itself
3. Can revert by removing PostHog provider

---

## Acceptance Criteria

- [ ] PostHog account created and project configured
- [ ] PostHog SDK installed and initialized
- [ ] Feature flags migrated to PostHog dashboard
- [ ] User identification working after login
- [ ] Page views tracked automatically
- [ ] Key events tracked (device view, commands, alerts)
- [ ] Settings page updated to show PostHog flags
- [ ] Homegrown feature flag code removed
- [ ] Documentation updated

---

## References

- [PostHog React Docs](https://posthog.com/docs/libraries/react)
- [PostHog Feature Flags](https://posthog.com/docs/feature-flags)
- [React Feature Flags with Vite](https://posthog.com/tutorials/react-feature-flags)
- [PostHog Pricing](https://posthog.com/pricing)
- Current implementation: `songbird-dashboard/src/contexts/FeatureFlagsContext.tsx`
