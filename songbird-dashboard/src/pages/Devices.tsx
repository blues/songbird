import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  ChevronUp,
  ChevronDown,
  Battery,
  Thermometer,
  MapPin,
  AlertTriangle,
  Satellite,
  Radio,
  Lock,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DeviceStatus } from '@/components/devices/DeviceStatus';
import { useDevices } from '@/hooks/useDevices';
import { useActiveAlerts } from '@/hooks/useAlerts';
import { usePreferences } from '@/contexts/PreferencesContext';
import {
  formatTemperature,
  formatBattery,
  formatMode,
  formatRelativeTime,
} from '@/utils/formatters';
import type { LocationSource } from '@/types';

type SortField = 'name' | 'status' | 'temperature' | 'battery' | 'last_seen';
type SortDirection = 'asc' | 'desc';

function getLocationSourceInfo(source?: LocationSource | string) {
  switch (source) {
    case 'gps':
      return { label: 'GPS', icon: Satellite, color: 'text-green-600' };
    case 'cell':
    case 'tower':
      return { label: 'Cell', icon: Radio, color: 'text-blue-600' };
    case 'wifi':
      return { label: 'Wi-Fi', icon: Radio, color: 'text-purple-600' };
    case 'triangulation':
    case 'triangulated':
      return { label: 'Tri', icon: Radio, color: 'text-orange-600' };
    default:
      return null;
  }
}

export function Devices() {
  const navigate = useNavigate();
  const { preferences } = usePreferences();
  const tempUnit = preferences.temp_unit === 'fahrenheit' ? 'F' : 'C';

  const { data: devicesData, isLoading } = useDevices();
  const { data: alertsData } = useActiveAlerts();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const devices = devicesData?.devices || [];
  const activeAlerts = alertsData?.alerts || [];

  // Build alert counts by device
  const alertsByDevice = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const alert of activeAlerts) {
      counts[alert.device_uid] = (counts[alert.device_uid] || 0) + 1;
    }
    return counts;
  }, [activeAlerts]);

  // Filter and sort devices
  const filteredDevices = useMemo(() => {
    let result = [...devices];

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (d) =>
          d.name?.toLowerCase().includes(query) ||
          d.serial_number?.toLowerCase().includes(query) ||
          d.device_uid.toLowerCase().includes(query) ||
          d.assigned_to_name?.toLowerCase().includes(query) ||
          d.location_name?.toLowerCase().includes(query)
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((d) => d.status === statusFilter);
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'name':
          const nameA = a.name || a.serial_number || a.device_uid;
          const nameB = b.name || b.serial_number || b.device_uid;
          comparison = nameA.localeCompare(nameB);
          break;
        case 'status':
          comparison = (a.status || '').localeCompare(b.status || '');
          break;
        case 'temperature':
          comparison = (a.temperature || 0) - (b.temperature || 0);
          break;
        case 'battery':
          comparison = (a.voltage || 0) - (b.voltage || 0);
          break;
        case 'last_seen':
          const timeA = a.last_seen ? new Date(a.last_seen).getTime() : 0;
          const timeB = b.last_seen ? new Date(b.last_seen).getTime() : 0;
          comparison = timeB - timeA; // Most recent first by default
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [devices, searchQuery, statusFilter, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDirection === 'asc' ? (
      <ChevronUp className="h-4 w-4 inline ml-1" />
    ) : (
      <ChevronDown className="h-4 w-4 inline ml-1" />
    );
  };

  const handleRowClick = (deviceUid: string) => {
    navigate(`/devices/${deviceUid}`);
  };

  // Stats
  const onlineCount = devices.filter((d) => d.status === 'online').length;
  const offlineCount = devices.filter((d) => d.status === 'offline').length;
  const alertCount = Object.keys(alertsByDevice).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Devices</h1>
          <p className="text-muted-foreground mt-1">
            {devices.length} device{devices.length !== 1 ? 's' : ''} total
            {' '}&bull;{' '}
            <span className="text-green-600">{onlineCount} online</span>
            {' '}&bull;{' '}
            <span className="text-red-600">{offlineCount} offline</span>
            {alertCount > 0 && (
              <>
                {' '}&bull;{' '}
                <span className="text-orange-600">{alertCount} with alerts</span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search devices..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Device Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('name')}
              >
                Device
                <SortIcon field="name" />
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('status')}
              >
                Status
                <SortIcon field="status" />
              </TableHead>
              <TableHead>Location</TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('temperature')}
              >
                <Thermometer className="h-4 w-4 inline mr-1" />
                Temp
                <SortIcon field="temperature" />
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('battery')}
              >
                <Battery className="h-4 w-4 inline mr-1" />
                Battery
                <SortIcon field="battery" />
              </TableHead>
              <TableHead
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleSort('last_seen')}
              >
                Last Seen
                <SortIcon field="last_seen" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <div className="h-12 bg-muted animate-pulse rounded" />
                  </TableCell>
                </TableRow>
              ))
            ) : filteredDevices.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  {searchQuery || statusFilter !== 'all'
                    ? 'No devices match your filters'
                    : 'No devices found'}
                </TableCell>
              </TableRow>
            ) : (
              filteredDevices.map((device) => {
                const battery = formatBattery(device.voltage);
                const alertCount = alertsByDevice[device.device_uid] || 0;
                const sourceInfo = getLocationSourceInfo(device.location_source);

                return (
                  <TableRow
                    key={device.device_uid}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => handleRowClick(device.device_uid)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            {device.name || device.serial_number || device.device_uid}
                            {alertCount > 0 && (
                              <Badge variant="destructive" className="gap-1 text-xs">
                                <AlertTriangle className="h-3 w-3" />
                                {alertCount}
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {device.assigned_to_name || device.assigned_to || (
                              <span className="italic">Unassigned</span>
                            )}
                            {device.mode && (
                              <Badge
                                variant={device.transit_locked || device.demo_locked ? "default" : "outline"}
                                className={`ml-2 text-xs ${
                                  device.transit_locked
                                    ? "gap-1 bg-amber-500 hover:bg-amber-600"
                                    : device.demo_locked
                                    ? "gap-1 bg-green-500 hover:bg-green-600"
                                    : ""
                                }`}
                              >
                                {(device.transit_locked || device.demo_locked) && <Lock className="h-2.5 w-2.5" />}
                                {formatMode(device.mode)}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <DeviceStatus status={device.status} />
                    </TableCell>
                    <TableCell>
                      {device.latitude && device.longitude ? (
                        <div className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <div>
                            <div className="text-sm truncate max-w-[150px]">
                              {device.location_name ||
                                `${device.latitude.toFixed(3)}, ${device.longitude.toFixed(3)}`}
                            </div>
                            {sourceInfo && (
                              <div className={`flex items-center gap-1 ${sourceInfo.color}`}>
                                <sourceInfo.icon className="h-3 w-3" />
                                <span className="text-xs">{sourceInfo.label}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">No location</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className={device.temperature && device.temperature > 35 ? 'text-orange-600 font-medium' : ''}>
                        {formatTemperature(device.temperature, tempUnit)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Battery
                          className={`h-4 w-4 ${
                            battery.level === 'critical'
                              ? 'text-red-500'
                              : battery.level === 'low'
                              ? 'text-yellow-500'
                              : 'text-green-500'
                          }`}
                        />
                        <span
                          className={
                            battery.level === 'critical'
                              ? 'text-red-600 font-medium'
                              : battery.level === 'low'
                              ? 'text-yellow-600'
                              : ''
                          }
                        >
                          {battery.percentage}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {device.last_seen ? (
                        <span className="text-sm text-muted-foreground">
                          {formatRelativeTime(device.last_seen)}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Results count */}
      {!isLoading && filteredDevices.length > 0 && (
        <p className="text-sm text-muted-foreground text-center">
          Showing {filteredDevices.length} of {devices.length} devices
        </p>
      )}
    </div>
  );
}
