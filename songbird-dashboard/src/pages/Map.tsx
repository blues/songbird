import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MapGL, { Marker, Popup, NavigationControl } from 'react-map-gl';
import type { MapRef } from 'react-map-gl';
import {
  MapPin,
  Satellite,
  Radio,
  ChevronLeft,
  ChevronRight,
  Search,
  ExternalLink,
  Bell,
  Navigation,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { useDevices } from '@/hooks/useDevices';
import { useSendPing, useSendLocate } from '@/hooks/useCommands';
import { useNotehubFleets } from '@/hooks/useSettings';
import { usePreferences } from '@/contexts/PreferencesContext';
import {
  formatRelativeTime,
  formatTemperature,
  formatBattery,
  formatMode,
} from '@/utils/formatters';
import type { Device, LocationSource } from '@/types';
import 'mapbox-gl/dist/mapbox-gl.css';

// Map style URLs
const MAP_STYLES = {
  street: 'mapbox://styles/mapbox/light-v11',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

// Location source display configuration
function getLocationSourceInfo(source?: LocationSource | string) {
  switch (source) {
    case 'gps':
      return { label: 'GPS', icon: Satellite, color: 'text-green-600' };
    case 'cell':
    case 'tower':
      return { label: 'Cell Tower', icon: Radio, color: 'text-blue-600' };
    case 'wifi':
      return { label: 'Wi-Fi', icon: Radio, color: 'text-purple-600' };
    case 'triangulation':
    case 'triangulated':
      return { label: 'Triangulation', icon: Radio, color: 'text-orange-600' };
    default:
      return null;
  }
}

interface MapProps {
  mapboxToken: string;
  selectedFleet?: string;
}

export function Map({ mapboxToken, selectedFleet }: MapProps) {
  const navigate = useNavigate();
  const { preferences } = usePreferences();
  const mapStyle = MAP_STYLES[preferences.map_style] || MAP_STYLES.street;
  const tempUnit = preferences.temp_unit === 'fahrenheit' ? 'F' : 'C';

  const mapRef = useRef<MapRef>(null);
  // Start with drawer closed on mobile (< 768px)
  const [drawerOpen, setDrawerOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 768 : true
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [fleetFilter, setFleetFilter] = useState<string>('all');
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  const { data: devicesData, isLoading } = useDevices();
  const { data: notehubFleetsData } = useNotehubFleets();
  const sendPingMutation = useSendPing();
  const sendLocateMutation = useSendLocate();

  // Get all devices
  const allDevices = devicesData?.devices || [];

  // Get fleets from Notehub API (has proper names)
  const notehubFleets = notehubFleetsData || [];

  // Build fleet lookup and list - prefer Notehub fleet names, fall back to device fleet IDs
  const fleets = useMemo(() => {
    // Start with Notehub fleets (these have proper names)
    const fleetMap: Record<string, string> = {};
    for (const fleet of notehubFleets) {
      fleetMap[fleet.uid] = fleet.name;
    }
    // Add any fleets from devices that aren't in Notehub (shouldn't happen, but be safe)
    for (const device of allDevices) {
      const fleetId = (device as any).fleet || device.fleet_uid;
      if (fleetId && !fleetMap[fleetId]) {
        fleetMap[fleetId] = device.fleet_name || fleetId;
      }
    }
    return Object.entries(fleetMap).map(([uid, name]) => ({ uid, name }));
  }, [notehubFleets, allDevices]);

  // Determine effective fleet filter (use header selection if set, otherwise local filter)
  const effectiveFleetFilter = selectedFleet && selectedFleet !== 'all' ? selectedFleet : fleetFilter;

  // Filter devices by fleet
  const devices = useMemo(() => {
    if (!effectiveFleetFilter || effectiveFleetFilter === 'all') {
      return allDevices;
    }
    return allDevices.filter((d) => {
      const fleetId = (d as any).fleet || d.fleet_uid;
      return fleetId === effectiveFleetFilter;
    });
  }, [allDevices, effectiveFleetFilter]);

  // Filter devices with location
  const devicesWithLocation = useMemo(
    () => devices.filter((d) => d.latitude != null && d.longitude != null),
    [devices]
  );

  // Filter devices by search query
  const filteredDevices = useMemo(() => {
    if (!searchQuery) return devices;
    const query = searchQuery.toLowerCase();
    return devices.filter(
      (d) =>
        d.name?.toLowerCase().includes(query) ||
        d.serial_number?.toLowerCase().includes(query) ||
        d.device_uid.toLowerCase().includes(query) ||
        d.location_name?.toLowerCase().includes(query)
    );
  }, [devices, searchQuery]);

  // Calculate bounds to fit all devices
  const bounds = useMemo(() => {
    if (devicesWithLocation.length === 0) return null;

    const lats = devicesWithLocation.map((d) => d.latitude!);
    const lons = devicesWithLocation.map((d) => d.longitude!);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [devicesWithLocation]);

  // Fit map to bounds
  const fitMapToBounds = useCallback(() => {
    if (!mapRef.current || !bounds) return;

    const padding = 50;

    if (devicesWithLocation.length === 1) {
      mapRef.current.flyTo({
        center: [devicesWithLocation[0].longitude!, devicesWithLocation[0].latitude!],
        zoom: 12,
        duration: 1000,
      });
    } else {
      mapRef.current.fitBounds(
        [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
        { padding, duration: 1000, maxZoom: 14 }
      );
    }
  }, [bounds, devicesWithLocation]);

  // Fit bounds when devices first load
  useEffect(() => {
    if (devicesWithLocation.length > 0 && !hasInitialized) {
      const timer = setTimeout(() => {
        fitMapToBounds();
        setHasInitialized(true);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [devicesWithLocation, hasInitialized, fitMapToBounds]);

  // Fly to device when selected from list
  const handleDeviceSelect = useCallback((device: Device) => {
    setSelectedDevice(device);
    if (device.latitude && device.longitude && mapRef.current) {
      mapRef.current.flyTo({
        center: [device.longitude, device.latitude],
        zoom: 14,
        duration: 1000,
      });
    }
    // Close drawer on mobile after selection
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setDrawerOpen(false);
    }
  }, []);

  // Handle marker click
  const handleMarkerClick = useCallback((device: Device) => {
    setSelectedDevice(device);
  }, []);

  // Handle quick actions
  const handlePing = useCallback((serialNumber: string) => {
    sendPingMutation.mutate(serialNumber);
  }, [sendPingMutation]);

  const handleLocate = useCallback((serialNumber: string) => {
    sendLocateMutation.mutate({ serialNumber });
  }, [sendLocateMutation]);

  // Default center (Austin, TX)
  const defaultCenter = { longitude: -97.7431, latitude: 30.2672 };

  // Stats
  const onlineCount = devices.filter((d) => d.status === 'online').length;
  const offlineCount = devices.filter((d) => d.status === 'offline').length;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] relative">
      {/* Mobile overlay backdrop */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-10"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Collapsible Device List Drawer */}
      <div
        className={`absolute top-0 left-0 h-full bg-background border-r z-20 transition-all duration-300 ${
          drawerOpen ? 'w-full sm:w-80' : 'w-0'
        } overflow-hidden`}
      >
        <div className="w-full sm:w-80 h-full flex flex-col">
          {/* Drawer Header */}
          <div className="p-4 border-b space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg">Devices</h2>
              {/* Close button for mobile */}
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setDrawerOpen(false)}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
            </div>
            <div className="text-sm text-muted-foreground">
              {devices.length} total &bull;{' '}
              <span className="text-green-600">{onlineCount} online</span> &bull;{' '}
              <span className="text-red-600">{offlineCount} offline</span>
            </div>
            {/* Fleet Filter */}
            <Select
              value={fleetFilter}
              onValueChange={setFleetFilter}
              disabled={fleets.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={fleets.length === 0 ? "No fleets available" : "Filter by fleet"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Fleets</SelectItem>
                {fleets.map((fleet) => (
                  <SelectItem key={fleet.uid} value={fleet.uid}>
                    {fleet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search devices..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* Device List */}
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-16 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : filteredDevices.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground">
                {searchQuery ? 'No devices match your search' : 'No devices found'}
              </div>
            ) : (
              <div className="divide-y">
                {filteredDevices.map((device) => {
                  const hasLocation = device.latitude != null && device.longitude != null;
                  const isSelected = selectedDevice?.device_uid === device.device_uid;

                  return (
                    <div
                      key={device.device_uid}
                      className={`p-3 cursor-pointer hover:bg-muted/50 transition-colors ${
                        isSelected ? 'bg-muted' : ''
                      } ${!hasLocation ? 'opacity-60' : ''}`}
                      onClick={() => hasLocation && handleDeviceSelect(device)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">
                            {device.name || device.serial_number || device.device_uid}
                          </div>
                          <div className="text-sm text-muted-foreground truncate">
                            {device.location_name || (
                              hasLocation
                                ? `${device.latitude!.toFixed(3)}, ${device.longitude!.toFixed(3)}`
                                : 'No location'
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <DeviceStatus status={device.status} showLabel={false} />
                            {device.mode && (
                              <Badge variant="outline" className="text-xs">
                                {formatMode(device.mode)}
                              </Badge>
                            )}
                          </div>
                        </div>
                        {hasLocation && (
                          <MapPin
                            className={`h-5 w-5 flex-shrink-0 ${
                              device.status === 'online'
                                ? 'text-green-500'
                                : device.status === 'offline'
                                ? 'text-red-500'
                                : 'text-gray-400'
                            }`}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drawer Toggle Button - Desktop */}
      <button
        onClick={() => setDrawerOpen(!drawerOpen)}
        className={`hidden md:flex absolute top-4 z-30 bg-background border rounded-r-md p-2 shadow-md transition-all duration-300 ${
          drawerOpen ? 'left-80' : 'left-0'
        }`}
      >
        {drawerOpen ? (
          <ChevronLeft className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>

      {/* Mobile: Floating button to open drawer when closed */}
      {!drawerOpen && (
        <Button
          onClick={() => setDrawerOpen(true)}
          className="md:hidden absolute top-4 left-4 z-30 shadow-lg"
          size="sm"
        >
          <MapPin className="h-4 w-4 mr-2" />
          Devices ({devices.length})
        </Button>
      )}

      {/* Map */}
      <div className="flex-1">
        <MapGL
          ref={mapRef}
          initialViewState={{
            ...defaultCenter,
            zoom: 4,
          }}
          style={{ width: '100%', height: '100%' }}
          mapStyle={mapStyle}
          mapboxAccessToken={mapboxToken}
          onClick={() => setSelectedDevice(null)}
        >
          <NavigationControl position="top-right" />

          {devicesWithLocation.map((device) => (
            <Marker
              key={device.device_uid}
              longitude={device.longitude!}
              latitude={device.latitude!}
              anchor="bottom"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                handleMarkerClick(device);
              }}
            >
              <div
                className={`cursor-pointer transition-transform hover:scale-110 ${
                  device.device_uid === selectedDevice?.device_uid ? 'scale-125' : ''
                }`}
              >
                <MapPin
                  className={`h-8 w-8 ${
                    device.status === 'online'
                      ? 'text-green-500'
                      : device.status === 'offline'
                      ? 'text-red-500'
                      : 'text-gray-400'
                  }`}
                  fill="currentColor"
                  strokeWidth={1.5}
                  stroke="white"
                />
              </div>
            </Marker>
          ))}

          {/* Selected Device Popup */}
          {selectedDevice && selectedDevice.latitude && selectedDevice.longitude && (
            <Popup
              longitude={selectedDevice.longitude}
              latitude={selectedDevice.latitude}
              anchor="top"
              closeButton={true}
              closeOnClick={false}
              onClose={() => setSelectedDevice(null)}
              maxWidth="320px"
            >
              <div className="p-2 min-w-[280px]">
                {/* Header */}
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold">
                    {selectedDevice.name || selectedDevice.serial_number}
                  </h4>
                  <DeviceStatus status={selectedDevice.status} />
                </div>

                {/* Location */}
                <div className="space-y-2 mb-3">
                  <div className="text-sm">
                    {selectedDevice.location_name ||
                      `${selectedDevice.latitude.toFixed(4)}, ${selectedDevice.longitude.toFixed(4)}`}
                  </div>
                  {(() => {
                    const sourceInfo = getLocationSourceInfo(selectedDevice.location_source);
                    if (!sourceInfo) return null;
                    const SourceIcon = sourceInfo.icon;
                    return (
                      <div className={`flex items-center gap-1.5 ${sourceInfo.color}`}>
                        <SourceIcon className="h-3.5 w-3.5" />
                        <span className="text-xs">{sourceInfo.label}</span>
                      </div>
                    );
                  })()}
                </div>

                {/* Telemetry */}
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  {selectedDevice.temperature !== undefined && (
                    <div>
                      <span className="text-muted-foreground">Temp:</span>{' '}
                      {formatTemperature(selectedDevice.temperature, tempUnit)}
                    </div>
                  )}
                  {selectedDevice.voltage !== undefined && (
                    <div>
                      <span className="text-muted-foreground">Battery:</span>{' '}
                      {formatBattery(selectedDevice.voltage).percentage}%
                    </div>
                  )}
                  {selectedDevice.mode && (
                    <div>
                      <span className="text-muted-foreground">Mode:</span>{' '}
                      {formatMode(selectedDevice.mode)}
                    </div>
                  )}
                  {selectedDevice.last_seen && (
                    <div>
                      <span className="text-muted-foreground">Seen:</span>{' '}
                      {formatRelativeTime(selectedDevice.last_seen)}
                    </div>
                  )}
                </div>

                {/* Quick Actions */}
                <div className="flex gap-2 pt-2 border-t">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => handlePing(selectedDevice.serial_number)}
                    disabled={sendPingMutation.isPending}
                  >
                    <Bell className="h-3.5 w-3.5 mr-1" />
                    Ping
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => handleLocate(selectedDevice.serial_number)}
                    disabled={sendLocateMutation.isPending}
                  >
                    <Navigation className="h-3.5 w-3.5 mr-1" />
                    Locate
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => navigate(`/devices/${selectedDevice.serial_number}`)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Popup>
          )}
        </MapGL>
      </div>
    </div>
  );
}
