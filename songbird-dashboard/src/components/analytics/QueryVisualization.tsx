import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  BarChart,
  ScatterChart,
  Line,
  Bar,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import Map, { Marker, NavigationControl } from 'react-map-gl';
import { MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { QueryResult } from '@/types/analytics';
import 'mapbox-gl/dist/mapbox-gl.css';

interface QueryVisualizationProps {
  result: QueryResult;
  mapboxToken: string;
}

export function QueryVisualization({ result, mapboxToken }: QueryVisualizationProps) {
  const { visualizationType, data } = result;

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No data to visualize
      </div>
    );
  }

  // Determine chart colors based on data keys
  const colors = [
    '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
  ];

  switch (visualizationType) {
    case 'line_chart':
      return <LineChartViz data={data} colors={colors} />;
    case 'bar_chart':
      return <BarChartViz data={data} colors={colors} />;
    case 'scatter':
      return <ScatterChartViz data={data} colors={colors} />;
    case 'map':
      return <MapViz data={data} mapboxToken={mapboxToken} />;
    case 'gauge':
      return <GaugeViz data={data} />;
    case 'table':
    default:
      return <TableViz data={data} />;
  }
}

function LineChartViz({ data, colors }: { data: any[]; colors: string[] }) {
  // Get numeric keys for line series
  const keys = Object.keys(data[0] || {}).filter(key => {
    const val = data[0][key];
    return typeof val === 'number' && !key.includes('id') && !key.includes('time');
  });

  // Get time/category key (x-axis)
  const xKey = Object.keys(data[0] || {}).find(key =>
    key.includes('time') || key.includes('date') || key.includes('day')
  ) || Object.keys(data[0])[0];

  return (
    <div>
      <h4 className="text-sm font-medium mb-3">Trend Analysis</h4>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey={xKey}
            className="text-xs"
            tickFormatter={(val) => {
              if (val instanceof Date) return val.toLocaleDateString();
              if (typeof val === 'string' && val.length > 20) return val.substring(0, 20) + '...';
              return val;
            }}
          />
          <YAxis className="text-xs" />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
            }}
          />
          <Legend />
          {keys.map((key, index) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors[index % colors.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BarChartViz({ data, colors }: { data: any[]; colors: string[] }) {
  const keys = Object.keys(data[0] || {}).filter(key => {
    const val = data[0][key];
    return typeof val === 'number';
  });

  const xKey = Object.keys(data[0] || {}).find(key =>
    key.includes('name') || key.includes('serial') || key.includes('type')
  ) || Object.keys(data[0])[0];

  return (
    <div>
      <h4 className="text-sm font-medium mb-3">Comparison</h4>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey={xKey}
            className="text-xs"
            angle={-45}
            textAnchor="end"
            height={80}
            tickFormatter={(val) => {
              if (typeof val === 'string' && val.length > 15) return val.substring(0, 15) + '...';
              return val;
            }}
          />
          <YAxis className="text-xs" />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
            }}
          />
          <Legend />
          {keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              fill={colors[index % colors.length]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ScatterChartViz({ data, colors }: { data: any[]; colors: string[] }) {
  const numericKeys = Object.keys(data[0] || {}).filter(key => {
    const val = data[0][key];
    return typeof val === 'number';
  });

  const xKey = numericKeys[0] || 'x';
  const yKey = numericKeys[1] || 'y';

  return (
    <div>
      <h4 className="text-sm font-medium mb-3">Scatter Plot</h4>
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis dataKey={xKey} className="text-xs" name={xKey} />
          <YAxis dataKey={yKey} className="text-xs" name={yKey} />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
            }}
          />
          <Scatter data={data} fill={colors[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function MapViz({ data, mapboxToken }: { data: any[]; mapboxToken: string }) {
  // Extract and normalize location data
  const locations = useMemo(() => {
    return data
      .map((row, index) => {
        // Try different column names for latitude/longitude
        const latValue = row.lat ?? row.latitude ?? row.last_location_lat;
        const lonValue = row.lon ?? row.longitude ?? row.last_location_lon;

        // Parse values - they might be strings or numbers
        const lat = typeof latValue === 'string' ? parseFloat(latValue) : latValue;
        const lon = typeof lonValue === 'string' ? parseFloat(lonValue) : lonValue;

        // Validate coordinates
        if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) {
          return null;
        }

        return {
          id: index,
          lat,
          lon,
          name: row.name || row.serial_number || `Location ${index + 1}`,
          time: row.time,
          source: row.source,
        };
      })
      .filter((loc): loc is NonNullable<typeof loc> => loc !== null);
  }, [data]);

  // Calculate map bounds
  const bounds = useMemo(() => {
    if (locations.length === 0) return null;

    const lats = locations.map(l => l.lat);
    const lons = locations.map(l => l.lon);

    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [locations]);

  // Calculate center and zoom
  const initialViewState = useMemo(() => {
    if (!bounds || locations.length === 0) {
      return { longitude: -97.7431, latitude: 30.2672, zoom: 4 };
    }

    const centerLat = (bounds.minLat + bounds.maxLat) / 2;
    const centerLon = (bounds.minLon + bounds.maxLon) / 2;

    // Calculate appropriate zoom based on bounds
    const latDiff = bounds.maxLat - bounds.minLat;
    const lonDiff = bounds.maxLon - bounds.minLon;
    const maxDiff = Math.max(latDiff, lonDiff);

    let zoom = 12;
    if (maxDiff > 50) zoom = 2;
    else if (maxDiff > 20) zoom = 4;
    else if (maxDiff > 10) zoom = 5;
    else if (maxDiff > 5) zoom = 6;
    else if (maxDiff > 1) zoom = 8;
    else if (maxDiff > 0.5) zoom = 10;

    return { longitude: centerLon, latitude: centerLat, zoom };
  }, [bounds, locations]);

  if (locations.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No location data available
      </div>
    );
  }

  if (!mapboxToken) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Mapbox token not configured
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
        <MapPin className="h-4 w-4" />
        Locations ({locations.length} points)
      </h4>
      <div className="rounded-lg overflow-hidden border" style={{ height: '350px' }}>
        <Map
          initialViewState={initialViewState}
          style={{ width: '100%', height: '100%' }}
          mapStyle="mapbox://styles/mapbox/light-v11"
          mapboxAccessToken={mapboxToken}
        >
          <NavigationControl position="top-right" />

          {locations.map((location) => (
            <Marker
              key={location.id}
              longitude={location.lon}
              latitude={location.lat}
              anchor="bottom"
            >
              <div className="cursor-pointer">
                <MapPin
                  className="h-6 w-6 text-purple-500"
                  fill="currentColor"
                  strokeWidth={1.5}
                  stroke="white"
                />
              </div>
            </Marker>
          ))}
        </Map>
      </div>

      {/* Location list below map */}
      <div className="mt-3 grid gap-2 max-h-[150px] overflow-y-auto">
        {locations.slice(0, 5).map((loc) => (
          <Card key={loc.id} className="p-2">
            <div className="flex items-center justify-between text-xs">
              <div>
                <p className="font-medium">{loc.name}</p>
                <p className="text-muted-foreground">
                  {loc.lat.toFixed(6)}, {loc.lon.toFixed(6)}
                  {loc.source && ` • ${loc.source}`}
                </p>
              </div>
              {loc.time && (
                <span className="text-muted-foreground">
                  {new Date(loc.time).toLocaleString()}
                </span>
              )}
            </div>
          </Card>
        ))}
        {locations.length > 5 && (
          <p className="text-xs text-center text-muted-foreground">
            + {locations.length - 5} more locations
          </p>
        )}
      </div>
    </div>
  );
}

function GaugeViz({ data }: { data: any[] }) {
  const row = data[0] || {};
  const value = Object.values(row).find(v => typeof v === 'number') as number;
  const label = Object.keys(row).find(k => typeof row[k] === 'number') || 'Value';

  return (
    <div className="flex flex-col items-center py-8">
      <h4 className="text-sm font-medium mb-4">{label}</h4>
      <div className="text-6xl font-bold text-purple-500">{value?.toFixed(1)}</div>
      <p className="text-sm text-muted-foreground mt-2">Current Reading</p>
    </div>
  );
}

function TableViz({ data }: { data: any[] }) {
  if (data.length === 0) return null;

  const columns = Object.keys(data[0]);
  const displayData = data.slice(0, 100); // Limit to 100 rows

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Results ({data.length} rows)</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              {columns.map((col) => (
                <th key={col} className="text-left p-2 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayData.map((row, index) => (
              <tr key={index} className="border-b hover:bg-muted/50">
                {columns.map((col) => (
                  <td key={col} className="p-2">
                    {formatCellValue(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.length > 100 && (
        <p className="text-xs text-center text-muted-foreground">
          Showing first 100 of {data.length} rows
        </p>
      )}
    </div>
  );
}

function formatCellValue(value: any): string {
  if (value === null || value === undefined) return '--';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toFixed(2);
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === 'string' && value.length > 50) return value.substring(0, 50) + '...';
  return String(value);
}
