/**
 * Feature Flags Settings Panel
 *
 * Admin-only panel for managing feature flags.
 * Shows all available flags with toggles and descriptions.
 */

import { FlaskConical, RotateCcw, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  useFeatureFlags,
  getFeatureFlagKeys,
  FEATURE_FLAG_INFO,
  type FeatureFlags as FeatureFlagsType,
} from '@/contexts/FeatureFlagsContext';

export function FeatureFlags() {
  const { flags, setFlag, resetFlags, enabledCount } = useFeatureFlags();
  const flagKeys = getFeatureFlagKeys();
  const [copied, setCopied] = useState(false);

  const handleToggle = (flag: keyof FeatureFlagsType) => {
    setFlag(flag, !flags[flag]);
  };

  const handleReset = () => {
    resetFlags();
  };

  const copyTestUrl = () => {
    // Generate URL with all currently enabled flags
    const url = new URL(window.location.origin);
    flagKeys.forEach(key => {
      if (flags[key]) {
        url.searchParams.set(`ff_${key}`, 'true');
      }
    });
    navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={copyTestUrl}
              disabled={enabledCount === 0}
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-1" />
                  Copy Test URL
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={enabledCount === 0}
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              Reset All
            </Button>
          </div>
        </div>
        <CardDescription>
          Enable or disable experimental features. Changes are saved locally and persist across sessions.
          Use "Copy Test URL" to share enabled features with others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {flagKeys.map((flag) => {
            const info = FEATURE_FLAG_INFO[flag];
            return (
              <div
                key={flag}
                className="flex items-center justify-between p-4 rounded-lg border bg-muted/30"
              >
                <div className="flex-1 min-w-0 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{info.name}</span>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      ff_{flag}
                    </code>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {info.description}
                  </p>
                </div>
                <Switch
                  checked={flags[flag]}
                  onCheckedChange={() => handleToggle(flag)}
                />
              </div>
            );
          })}

          {flagKeys.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No feature flags defined.
            </p>
          )}
        </div>

        <div className="mt-6 p-4 rounded-lg bg-muted/50 border border-dashed">
          <h4 className="text-sm font-medium mb-2">Quick Enable via URL</h4>
          <p className="text-xs text-muted-foreground">
            You can enable features by adding URL parameters. For example:
          </p>
          <code className="text-xs block mt-2 p-2 bg-background rounded">
            {window.location.origin}?ff_analytics=true
          </code>
        </div>
      </CardContent>
    </Card>
  );
}
