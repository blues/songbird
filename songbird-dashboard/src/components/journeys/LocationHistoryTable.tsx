import { useState } from 'react';
import { MapPin, Satellite, Radio, Clock, Filter } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatRelativeTime } from '@/utils/formatters';
import type { LocationHistoryPoint, LocationSource } from '@/types';

interface LocationHistoryTableProps {
  locations: LocationHistoryPoint[];
  isLoading?: boolean;
  onLocationClick?: (location: LocationHistoryPoint) => void;
}

// Get icon and color for location source
function getSourceInfo(source: LocationSource) {
  switch (source) {
    case 'gps':
      return { icon: Satellite, color: 'text-green-600', bgColor: 'bg-green-100', label: 'GPS' };
    case 'cell':
    case 'tower':
      return { icon: Radio, color: 'text-blue-600', bgColor: 'bg-blue-100', label: 'Cell' };
    case 'wifi':
      return { icon: Radio, color: 'text-purple-600', bgColor: 'bg-purple-100', label: 'Wi-Fi' };
    case 'triangulation':
      return { icon: Radio, color: 'text-orange-600', bgColor: 'bg-orange-100', label: 'Triangulated' };
    default:
      return { icon: MapPin, color: 'text-gray-600', bgColor: 'bg-gray-100', label: 'Unknown' };
  }
}

type SourceFilter = 'all' | LocationSource;

export function LocationHistoryTable({
  locations,
  isLoading,
  onLocationClick,
}: LocationHistoryTableProps) {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  // Filter locations by source
  const filteredLocations = sourceFilter === 'all'
    ? locations
    : locations.filter((l) => l.source === sourceFilter);

  // Count locations by source
  const sourceCounts = locations.reduce((acc, loc) => {
    acc[loc.source] = (acc[loc.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Format velocity for display
  const formatVelocity = (velocity?: number) => {
    if (velocity === undefined) return null;
    // Convert m/s to km/h
    const kmh = velocity * 3.6;
    return `${kmh.toFixed(1)} km/h`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <span className="text-muted-foreground">Loading locations...</span>
      </div>
    );
  }

  if (locations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
        <MapPin className="h-8 w-8 mb-2" />
        <p>No location history</p>
        <p className="text-sm">Location data will appear here as the device reports its position</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {filteredLocations.length} location{filteredLocations.length !== 1 ? 's' : ''}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="h-3 w-3 mr-2" />
              {sourceFilter === 'all' ? 'All Sources' : getSourceInfo(sourceFilter as LocationSource).label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSourceFilter('all')}>
              All Sources ({locations.length})
            </DropdownMenuItem>
            {Object.entries(sourceCounts).map(([source, count]) => {
              const info = getSourceInfo(source as LocationSource);
              return (
                <DropdownMenuItem
                  key={source}
                  onClick={() => setSourceFilter(source as SourceFilter)}
                >
                  <info.icon className={`h-3 w-3 mr-2 ${info.color}`} />
                  {info.label} ({count})
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Location list */}
      <ScrollArea className="h-[400px]">
        <div className="space-y-2 pr-4">
          {filteredLocations.map((location, index) => {
            const sourceInfo = getSourceInfo(location.source);
            const SourceIcon = sourceInfo.icon;
            const velocity = formatVelocity(location.velocity);

            return (
              <button
                key={`${location.time}-${index}`}
                onClick={() => onLocationClick?.(location)}
                className="w-full text-left p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className={`p-1.5 rounded ${sourceInfo.bgColor}`}>
                      <SourceIcon className={`h-4 w-4 ${sourceInfo.color}`} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`${sourceInfo.bgColor} border-0`}>
                          <span className={sourceInfo.color}>{sourceInfo.label}</span>
                        </Badge>
                        {location.journey_id && (
                          <Badge variant="secondary" className="text-xs">
                            Journey point {location.jcount}
                          </Badge>
                        )}
                      </div>
                      <div className="text-sm mt-1">
                        <span className="font-mono text-muted-foreground">
                          {location.lat.toFixed(6)}, {location.lon.toFixed(6)}
                        </span>
                      </div>
                      {location.location_name && (
                        <div className="text-sm text-muted-foreground mt-0.5">
                          {location.location_name}
                        </div>
                      )}
                      {velocity && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {velocity}
                          {location.bearing !== undefined && (
                            <span className="ml-2">Heading: {location.bearing.toFixed(0)}°</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatRelativeTime(new Date(location.time))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
