/**
 * Notehub Connection Component
 *
 * Displays Notehub project status, routes, and connection health.
 */

import { Cloud, CheckCircle, AlertCircle, XCircle, RefreshCw, Wifi, Building2, Cpu } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { getNotehubStatus } from '@/api/notehub';
import { formatRelativeTime } from '@/utils/formatters';

export function NotehubConnection() {
  const { data: status, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['notehubStatus'],
    queryFn: getNotehubStatus,
    staleTime: 60_000, // 1 minute
    refetchInterval: 5 * 60_000, // Refetch every 5 minutes
  });

  const getHealthIcon = (health: string) => {
    switch (health) {
      case 'healthy':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'warning':
        return <AlertCircle className="h-5 w-5 text-yellow-500" />;
      case 'error':
        return <XCircle className="h-5 w-5 text-red-500" />;
      default:
        return <AlertCircle className="h-5 w-5 text-gray-500" />;
    }
  };

  const getHealthBadge = (health: string) => {
    switch (health) {
      case 'healthy':
        return <Badge className="bg-green-100 text-green-800">Healthy</Badge>;
      case 'warning':
        return <Badge className="bg-yellow-100 text-yellow-800">Warning</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="secondary">Unknown</Badge>;
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading Notehub status...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !status) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center">
            <XCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
            <h3 className="font-semibold">Unable to connect to Notehub</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {error instanceof Error ? error.message : 'Connection failed'}
            </p>
            <Button onClick={() => refetch()} variant="outline" className="mt-4">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Cloud className="h-6 w-6 text-blue-500" />
              <div>
                <CardTitle>Notehub Connection</CardTitle>
                <CardDescription>
                  Connection status to Blues Notehub
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {getHealthBadge(status.health)}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              {getHealthIcon(status.health)}
              <div>
                <div className="text-sm font-medium">Status</div>
                <div className="text-2xl font-bold capitalize">{status.health}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Cpu className="h-5 w-5 text-purple-500" />
              <div>
                <div className="text-sm font-medium">Devices</div>
                <div className="text-2xl font-bold">{status.device_count}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
              <Building2 className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-sm font-medium">Fleets</div>
                <div className="text-2xl font-bold">{status.fleets.length}</div>
              </div>
            </div>
          </div>

          {status.error && (
            <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200">
              <div className="flex items-center gap-2 text-red-800">
                <XCircle className="h-4 w-4" />
                <span className="text-sm font-medium">Error: {status.error}</span>
              </div>
            </div>
          )}

          <div className="mt-4 text-sm text-muted-foreground">
            Last checked: {formatRelativeTime(status.last_checked)}
          </div>
        </CardContent>
      </Card>

      {/* Project Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Project Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Project Name</dt>
              <dd className="font-medium">{status.project.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Project UID</dt>
              <dd className="font-mono text-xs">{status.project.uid}</dd>
            </div>
            {status.project.created && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{new Date(status.project.created).toLocaleDateString()}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Routes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Wifi className="h-5 w-5" />
            Configured Routes
          </CardTitle>
          <CardDescription>
            Routes delivering events from Notehub to this application
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status.routes.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <Wifi className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No routes configured</p>
              <p className="text-xs mt-1">
                Configure routes in Notehub to send events to this application
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {status.routes.map(route => (
                <div
                  key={route.uid}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <div className={`h-2 w-2 rounded-full ${route.enabled ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <div>
                      <div className="font-medium">{route.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {route.type} {route.url && `• ${route.url}`}
                      </div>
                    </div>
                  </div>
                  <Badge variant={route.enabled ? 'default' : 'secondary'}>
                    {route.enabled ? 'Active' : 'Disabled'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fleets */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Fleets
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status.fleets.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <Building2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No fleets configured</p>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {status.fleets.map(fleet => (
                <div
                  key={fleet.uid}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div>
                    <div className="font-medium">{fleet.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {fleet.uid}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
