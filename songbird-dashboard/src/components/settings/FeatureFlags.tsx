/**
 * Feature Flags Settings Panel
 *
 * Shows current PostHog feature flag states.
 * Flags are managed in the PostHog dashboard, not locally.
 */

import { FlaskConical, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useFeatureFlags, type FeatureFlagKey } from '@/hooks/useFeatureFlags';

/**
 * Feature flag metadata for display
 */
const FEATURE_FLAG_INFO: Record<FeatureFlagKey, { name: string; description: string }> = {
  analytics: {
    name: 'Analytics',
    description: 'Enable the Analytics page with natural language queries and data visualization',
  },
};

const FLAG_KEYS: FeatureFlagKey[] = ['analytics'];

export function FeatureFlags() {
  const flags = useFeatureFlags();
  const enabledCount = FLAG_KEYS.filter(key => flags[key]).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-purple-500" />
            <CardTitle>Feature Flags</CardTitle>
            {enabledCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {enabledCount} enabled
              </Badge>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            asChild
          >
            <a
              href="https://app.posthog.com/feature_flags"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-4 w-4 mr-1" />
              Manage in PostHog
            </a>
          </Button>
        </div>
        <CardDescription>
          Feature flags are managed via PostHog. Changes made in the PostHog dashboard
          will be reflected here in real-time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {FLAG_KEYS.map((flag) => {
            const info = FEATURE_FLAG_INFO[flag];
            const isEnabled = flags[flag];
            return (
              <div
                key={flag}
                className="flex items-center justify-between p-4 rounded-lg border bg-muted/30"
              >
                <div className="flex-1 min-w-0 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{info.name}</span>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {flag}
                    </code>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {info.description}
                  </p>
                </div>
                <Badge variant={isEnabled ? 'default' : 'outline'}>
                  {isEnabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            );
          })}

          {FLAG_KEYS.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No feature flags defined.
            </p>
          )}
        </div>

        <div className="mt-6 p-4 rounded-lg bg-muted/50 border border-dashed">
          <h4 className="text-sm font-medium mb-2">About Feature Flags</h4>
          <p className="text-xs text-muted-foreground">
            Feature flags are controlled through PostHog. To enable or disable a feature,
            visit the PostHog dashboard and update the flag configuration. Changes apply
            in real-time without requiring a page reload.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
