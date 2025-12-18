import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Clock, MapPin } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAlerts, useAcknowledgeAlert } from '@/hooks/useAlerts';
import { formatRelativeTime } from '@/utils/formatters';
import type { Alert } from '@/types';

const alertTypeLabels: Record<string, string> = {
  temp_high: 'High Temperature',
  temp_low: 'Low Temperature',
  humidity_high: 'High Humidity',
  humidity_low: 'Low Humidity',
  pressure_change: 'Pressure Change',
  low_battery: 'Low Battery',
  motion: 'Motion Detected',
};

const alertTypeColors: Record<string, string> = {
  temp_high: 'bg-red-500',
  temp_low: 'bg-blue-500',
  humidity_high: 'bg-cyan-500',
  humidity_low: 'bg-orange-500',
  pressure_change: 'bg-purple-500',
  low_battery: 'bg-yellow-500',
  motion: 'bg-green-500',
};

interface AlertCardProps {
  alert: Alert;
  onAcknowledge: (alertId: string) => void;
  isAcknowledging: boolean;
  onDeviceClick: (deviceUid: string) => void;
}

function AlertCard({ alert, onAcknowledge, isAcknowledging, onDeviceClick }: AlertCardProps) {
  const isAcknowledged = alert.acknowledged === 'true' || alert.acknowledged === true;

  return (
    <Card className={isAcknowledged ? 'opacity-60' : ''}>
      <CardContent className="pt-6">
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-full ${alertTypeColors[alert.type] || 'bg-gray-500'}`}>
            <AlertTriangle className="h-5 w-5 text-white" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold">
                {alertTypeLabels[alert.type] || alert.type}
              </h3>
              {isAcknowledged ? (
                <Badge variant="secondary" className="text-xs">
                  <Check className="h-3 w-3 mr-1" />
                  Acknowledged
                </Badge>
              ) : (
                <Badge variant="destructive" className="text-xs">Active</Badge>
              )}
            </div>

            <p className="text-sm text-muted-foreground mb-2">
              {alert.message || `${alertTypeLabels[alert.type]} alert triggered`}
            </p>

            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <button
                onClick={() => onDeviceClick(alert.device_uid)}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <MapPin className="h-3 w-3" />
                {alert.serial_number || alert.device_uid}
              </button>

              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatRelativeTime(new Date(alert.created_at))}
              </span>

              {alert.value !== undefined && (
                <span>Value: {alert.value.toFixed(2)}</span>
              )}

              {alert.threshold !== undefined && (
                <span>Threshold: {alert.threshold}</span>
              )}
            </div>

            {isAcknowledged && alert.acknowledged_at && (
              <p className="text-xs text-muted-foreground mt-2">
                Acknowledged {formatRelativeTime(new Date(alert.acknowledged_at))}
                {alert.acknowledged_by && ` by ${alert.acknowledged_by}`}
              </p>
            )}
          </div>

          {!isAcknowledged && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAcknowledge(alert.alert_id)}
              disabled={isAcknowledging}
            >
              <Check className="h-4 w-4 mr-1" />
              Acknowledge
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function Alerts() {
  const navigate = useNavigate();
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  const { data, isLoading, error } = useAlerts({
    acknowledged: showAcknowledged ? undefined : false,
    limit: 100,
  });

  const acknowledgeMutation = useAcknowledgeAlert();

  const handleAcknowledge = (alertId: string) => {
    acknowledgeMutation.mutate({ alertId });
  };

  const handleDeviceClick = (deviceUid: string) => {
    navigate(`/devices/${deviceUid}`);
  };

  const alerts = data?.alerts || [];
  const activeCount = data?.active_count || 0;

  if (error) {
    return (
      <div className="text-center py-12">
        <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Error Loading Alerts</h2>
        <p className="text-muted-foreground">
          {error instanceof Error ? error.message : 'Failed to load alerts'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Alerts</h1>
          <p className="text-muted-foreground">
            {activeCount} active alert{activeCount !== 1 ? 's' : ''}
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() => setShowAcknowledged(!showAcknowledged)}
        >
          {showAcknowledged ? 'Show Active Only' : 'Show All Alerts'}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-3xl font-bold text-red-500">{activeCount}</div>
              <div className="text-sm text-muted-foreground">Active Alerts</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="text-3xl font-bold">{data?.count || 0}</div>
              <div className="text-sm text-muted-foreground">
                {showAcknowledged ? 'Total Alerts' : 'Unacknowledged'}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Alerts List */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  <div className="h-11 w-11 bg-muted rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded w-1/4" />
                    <div className="h-3 bg-muted rounded w-1/2" />
                    <div className="h-3 bg-muted rounded w-1/3" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Check className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Active Alerts</h3>
            <p className="text-muted-foreground">
              {showAcknowledged
                ? 'No alerts have been recorded yet.'
                : 'All alerts have been acknowledged.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {alerts.map((alert) => (
            <AlertCard
              key={alert.alert_id}
              alert={alert}
              onAcknowledge={handleAcknowledge}
              isAcknowledging={acknowledgeMutation.isPending}
              onDeviceClick={handleDeviceClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
