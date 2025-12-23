import { MapPin, Clock, Route, Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatRelativeTime } from '@/utils/formatters';
import type { Journey } from '@/types';

interface JourneySelectorProps {
  journeys: Journey[];
  selectedJourneyId: number | null;
  onSelect: (journeyId: number) => void;
  isLoading?: boolean;
}

export function JourneySelector({
  journeys,
  selectedJourneyId,
  onSelect,
  isLoading,
}: JourneySelectorProps) {
  // Format distance for display
  const formatDistance = (meters: number) => {
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(1)} km`;
    }
    return `${Math.round(meters)} m`;
  };

  // Format duration for display
  const formatDuration = (startTime: string, endTime?: string) => {
    if (!endTime) return 'In progress';

    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    const durationMs = end - start;

    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <span className="text-muted-foreground">Loading journeys...</span>
      </div>
    );
  }

  if (journeys.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
        <Route className="h-8 w-8 mb-2" />
        <p>No journeys recorded</p>
        <p className="text-sm">Journeys are recorded when the device is in transit mode</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[400px]">
      <div className="space-y-2 pr-4">
        {journeys.map((journey) => {
          const isSelected = selectedJourneyId === journey.journey_id;
          const isActive = journey.status === 'active';

          return (
            <button
              key={journey.journey_id}
              onClick={() => onSelect(journey.journey_id)}
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                isSelected
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <MapPin className={`h-4 w-4 ${isActive ? 'text-green-500' : 'text-muted-foreground'}`} />
                  <span className="font-medium">
                    {new Date(journey.start_time).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </div>
                <Badge variant={isActive ? 'default' : 'secondary'} className={isActive ? 'bg-green-500' : ''}>
                  {isActive ? 'Active' : 'Completed'}
                </Badge>
              </div>

              <div className="grid grid-cols-3 gap-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{formatDuration(journey.start_time, journey.end_time)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Route className="h-3 w-3" />
                  <span>{formatDistance(journey.total_distance)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Activity className="h-3 w-3" />
                  <span>{journey.point_count} points</span>
                </div>
              </div>

              <div className="mt-2 text-xs text-muted-foreground">
                Started {formatRelativeTime(new Date(journey.start_time))}
              </div>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
