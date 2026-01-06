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
import { celsiusToFahrenheit } from '@/utils/formatters';
import type { TelemetryPoint } from '@/types';

interface TelemetryChartProps {
  data: TelemetryPoint[];
  showTemperature?: boolean;
  showHumidity?: boolean;
  showPressure?: boolean;
  height?: number;
  tempUnit?: 'C' | 'F';
}

export function TelemetryChart({
  data,
  showTemperature = true,
  showHumidity = true,
  showPressure = false,
  height = 300,
  tempUnit = 'C',
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

  const formatXAxis = (timestamp: number) => {
    return format(new Date(timestamp), 'HH:mm');
  };

  const formatTooltip = (timestamp: number) => {
    return format(new Date(timestamp), 'MMM d, HH:mm:ss');
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="timestamp"
          tickFormatter={formatXAxis}
          className="text-xs"
          stroke="currentColor"
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
          wrapperStyle={{ fontSize: '12px' }}
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

        {showPressure && (
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="pressure"
            name="Pressure (hPa)"
            stroke="#a855f7"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
