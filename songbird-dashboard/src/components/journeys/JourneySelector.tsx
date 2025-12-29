import { useState } from 'react';
import { MapPin, Clock, Route, Activity, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatRelativeTime } from '@/utils/formatters';
import { usePreferences } from '@/contexts/PreferencesContext';
import type { Journey } from '@/types';

interface JourneySelectorProps {
  journeys: Journey[];
  selectedJourneyId: number | null;
  onSelect: (journeyId: number) => void;
  isLoading?: boolean;
  canDelete?: boolean;
  onDelete?: (journeyId: number) => void;
  isDeleting?: boolean;
}

export function JourneySelector({
  journeys,
  selectedJourneyId,
  onSelect,
  isLoading,
  canDelete = false,
  onDelete,
  isDeleting = false,
}: JourneySelectorProps) {
  const { preferences } = usePreferences();
  const [journeyToDelete, setJourneyToDelete] = useState<Journey | null>(null);
  const [deletingJourneyId, setDeletingJourneyId] = useState<number | null>(null);

  // Format distance for display (respects distance_unit preference)
  const formatDistance = (meters: number) => {
    if (preferences.distance_unit === 'mi') {
      const miles = meters / 1609.344;
      if (miles < 0.1) {
        // Show in feet for very short distances
        const feet = meters * 3.28084;
        return `${Math.round(feet)} ft`;
      }
      return `${miles.toFixed(1)} mi`;
    }
    // Metric
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

  const handleDeleteClick = (e: React.MouseEvent, journey: Journey) => {
    e.stopPropagation(); // Prevent selecting the journey
    setJourneyToDelete(journey);
  };

  const handleConfirmDelete = () => {
    if (journeyToDelete && onDelete) {
      const journeyId = journeyToDelete.journey_id;
      setJourneyToDelete(null);
      setDeletingJourneyId(journeyId);
      // Wait for animation to complete before actually deleting
      setTimeout(() => {
        onDelete(journeyId);
        setDeletingJourneyId(null);
      }, 300);
    }
  };

  return (
    <>
      <ScrollArea className="h-[400px]">
        <div className="space-y-2 pr-4">
          {journeys.map((journey) => {
            const isSelected = selectedJourneyId === journey.journey_id;
            const isActive = journey.status === 'active';
            const isBeingDeleted = deletingJourneyId === journey.journey_id;

            return (
              <div
                key={journey.journey_id}
                className={`relative w-full text-left p-3 rounded-lg border cursor-pointer transition-all duration-300 ease-out ${
                  isBeingDeleted
                    ? 'opacity-0 scale-95 -translate-x-4 max-h-0 !p-0 !mb-0 overflow-hidden border-transparent'
                    : 'opacity-100 scale-100 translate-x-0 max-h-40'
                } ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
                onClick={() => onSelect(journey.journey_id)}
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
                  <div className="flex items-center gap-2">
                    <Badge variant={isActive ? 'default' : 'secondary'} className={isActive ? 'bg-green-500' : ''}>
                      {isActive ? 'Active' : 'Completed'}
                    </Badge>
                    {canDelete && !isActive && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => handleDeleteClick(e, journey)}
                        disabled={isDeleting}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
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
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!journeyToDelete} onOpenChange={(open: boolean) => !open && setJourneyToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Journey</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this journey from{' '}
              {journeyToDelete && new Date(journeyToDelete.start_time).toLocaleDateString()}?
              This will permanently remove the journey and all {journeyToDelete?.point_count || 0} location points.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setJourneyToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
            >
              Delete Journey
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
