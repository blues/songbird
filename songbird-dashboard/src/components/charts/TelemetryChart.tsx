import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { Thermometer, Droplets, Gauge, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { celsiusToFahrenheit } from '@/utils/formatters';
import type { TelemetryPoint } from '@/types';

interface TelemetryChartProps {
  data: TelemetryPoint[];
  showTemperature?: boolean;
  showHumidity?: boolean;
  showPressure?: boolean;
  height?: number;
  tempUnit?: 'C' | 'F';
  hours?: number;
}

interface StatsSummary {
  min: number;
  max: number;
  avg: number;
  current: number;
  trend: 'up' | 'down' | 'stable';
}

function calculateStats(values: number[]): StatsSummary | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const current = values[values.length - 1];

  // Calculate trend from last 25% of data points
  const trendWindow = Math.max(2, Math.floor(values.length * 0.25));
  const recentValues = values.slice(-trendWindow);
  const trendStart = recentValues[0];
  const trendEnd = recentValues[recentValues.length - 1];
  const trendDelta = trendEnd - trendStart;
  const threshold = (max - min) * 0.05; // 5% of range

  let trend: 'up' | 'down' | 'stable' = 'stable';
  if (trendDelta > threshold) trend = 'up';
  else if (trendDelta < -threshold) trend = 'down';

  return { min, max, avg, current, trend };
}

function TrendIcon({ trend }: { trend: 'up' | 'down' | 'stable' }) {
  if (trend === 'up') return <TrendingUp className="h-3 w-3 text-green-500" />;
  if (trend === 'down') return <TrendingDown className="h-3 w-3 text-red-500" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

export function TelemetryChart({
  data,
  showTemperature = true,
  showHumidity = true,
  showPressure = false,
  height = 300,
  tempUnit = 'C',
  hours,
}: TelemetryChartProps) {
  // Transform data for chart - reverse to show chronological order
  // Convert temperature to preferred unit
  const chartData = [...data].reverse().map((point) => ({
    ...point,
    timestamp: parseISO(point.time).getTime(),
    temperature: point.temperature !== undefined
      ? (tempUnit === 'F' ? celsiusToFahrenheit(point.temperature) : point.temperature)
      : undefined,
  }));

  // Calculate stats for each metric
  const tempValues = chartData
    .filter((d) => d.temperature !== undefined)
    .map((d) => d.temperature!);
  const humidityValues = chartData
    .filter((d) => d.humidity !== undefined)
    .map((d) => d.humidity!);
  const pressureValues = chartData
    .filter((d) => d.pressure !== undefined)
    .map((d) => d.pressure!);

  const tempStats = showTemperature ? calculateStats(tempValues) : null;
  const humidityStats = showHumidity ? calculateStats(humidityValues) : null;
  const pressureStats = showPressure ? calculateStats(pressureValues) : null;

  const hasAnyStats = tempStats || humidityStats || pressureStats;

  const now = Date.now();
  const earliestData = chartData.length > 0 ? chartData[0].timestamp : undefined;
  const latestData = chartData.length > 0 ? chartData[chartData.length - 1].timestamp : now;
  const xDomainRight = Math.min(latestData, now);
  const windowLeft = hours ? xDomainRight - hours * 60 * 60 * 1000 : undefined;
  // Clamp left bound to earliest data so we don't show empty leading space
  const xDomainLeft = windowLeft !== undefined && earliestData !== undefined
    ? Math.max(windowLeft, earliestData)
    : windowLeft ?? earliestData;
  const xDomain: [number, number] | undefined = xDomainLeft !== undefined
    ? [xDomainLeft, xDomainRight]
    : undefined;

  const formatXAxis = (timestamp: number) => {
    if (hours && hours >= 168) return format(new Date(timestamp), 'MMM d');
    if (hours && hours >= 24) return format(new Date(timestamp), 'MMM d HH:mm');
    return format(new Date(timestamp), 'HH:mm');
  };

  const xAxisTickCount = hours && hours >= 168 ? 7 : hours && hours >= 24 ? 6 : 6;
  const xAxisAngle = hours && hours >= 24 ? -45 : 0;
  const xAxisHeight = hours && hours >= 24 ? 60 : 30;

  const formatTooltip = (timestamp: number) => {
    return format(new Date(timestamp), 'MMM d, HH:mm:ss');
  };

  return (
    <div className="space-y-4">
      {/* Summary Stats Card */}
      {hasAnyStats && (
        <div className="rounded-lg border bg-card p-4">
          <div className="grid grid-cols-3 gap-4">
            {/* Temperature Stats */}
            {tempStats && (
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-2">
                  <Thermometer className="h-3 w-3 text-orange-500" />
                  Temperature
                  <TrendIcon trend={tempStats.trend} />
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-semibold text-orange-500">
                    {tempStats.current.toFixed(1)}°{tempUnit}
                  </span>
                </div>
                <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                  <span>Min: {tempStats.min.toFixed(1)}°</span>
                  <span>Max: {tempStats.max.toFixed(1)}°</span>
                  <span>Avg: {tempStats.avg.toFixed(1)}°</span>
                </div>
              </div>
            )}

            {/* Humidity Stats */}
            {humidityStats && (
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-2">
                  <Droplets className="h-3 w-3 text-blue-500" />
                  Humidity
                  <TrendIcon trend={humidityStats.trend} />
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-semibold text-blue-500">
                    {humidityStats.current.toFixed(0)}%
                  </span>
                </div>
                <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                  <span>Min: {humidityStats.min.toFixed(0)}%</span>
                  <span>Max: {humidityStats.max.toFixed(0)}%</span>
                  <span>Avg: {humidityStats.avg.toFixed(0)}%</span>
                </div>
              </div>
            )}

            {/* Pressure Stats */}
            {pressureStats && (
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-2">
                  <Gauge className="h-3 w-3 text-purple-500" />
                  Pressure
                  <TrendIcon trend={pressureStats.trend} />
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-semibold text-purple-500">
                    {pressureStats.current.toFixed(0)}
                  </span>
                  <span className="text-xs text-muted-foreground">hPa</span>
                </div>
                <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                  <span>Min: {pressureStats.min.toFixed(0)}</span>
                  <span>Max: {pressureStats.max.toFixed(0)}</span>
                  <span>Avg: {pressureStats.avg.toFixed(0)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Temperature & Humidity Chart */}
      {(showTemperature || showHumidity) && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-muted-foreground">
            Temperature & Humidity
          </h4>
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: xAxisHeight - 30 + 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
                type="number"
                scale="time"
                domain={xDomain}
                tickCount={xAxisTickCount}
                angle={xAxisAngle}
                textAnchor={xAxisAngle !== 0 ? 'end' : 'middle'}
                height={xAxisHeight}
              />

              {/* Temperature Y-Axis */}
              {showTemperature && (
                <YAxis
                  yAxisId="temp"
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `${v}°`}
                  className="text-xs"
                  stroke="#f97316"
                  width={40}
                />
              )}

              {/* Humidity Y-Axis */}
              {showHumidity && !showTemperature && (
                <YAxis
                  yAxisId="humidity"
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  className="text-xs"
                  stroke="#3b82f6"
                  width={40}
                />
              )}

              {showHumidity && showTemperature && (
                <YAxis
                  yAxisId="humidity"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  className="text-xs"
                  stroke="#3b82f6"
                  width={40}
                />
              )}

              <Tooltip
                labelFormatter={formatTooltip}
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '12px', paddingTop: '12px' }}
                iconSize={12}
              />

              {showTemperature && (
                <Line
                  yAxisId="temp"
                  type="monotone"
                  dataKey="temperature"
                  name={`Temperature (°${tempUnit})`}
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              )}

              {showHumidity && (
                <Line
                  yAxisId={showTemperature ? 'humidity' : 'humidity'}
                  type="monotone"
                  dataKey="humidity"
                  name="Humidity (%)"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Pressure Chart - Separate chart with its own scale */}
      {showPressure && pressureValues.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-purple-500">
            Barometric Pressure
          </h4>
          <ResponsiveContainer width="100%" height={120 + (xAxisHeight - 30)}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 5, bottom: xAxisHeight - 30 + 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
                type="number"
                scale="time"
                domain={xDomain}
                tickCount={xAxisTickCount}
                angle={xAxisAngle}
                textAnchor={xAxisAngle !== 0 ? 'end' : 'middle'}
                height={xAxisHeight}
              />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={(v) => `${Math.round(v)}`}
                className="text-xs"
                stroke="#a855f7"
                width={40}
              />
              <Tooltip
                labelFormatter={formatTooltip}
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                }}
                formatter={(value: number) => [`${Math.round(value)} hPa`, 'Pressure']}
              />
              <Line
                type="monotone"
                dataKey="pressure"
                name="Pressure (hPa)"
                stroke="#a855f7"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
