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
import type { TelemetryPoint } from '@/types';

interface TelemetryChartProps {
  data: TelemetryPoint[];
  showTemperature?: boolean;
  showHumidity?: boolean;
  showPressure?: boolean;
  showVoltage?: boolean;
  height?: number;
}

export function TelemetryChart({
  data,
  showTemperature = true,
  showHumidity = true,
  showPressure = false,
  showVoltage = false,
  height = 300,
}: TelemetryChartProps) {
  // Transform data for chart - reverse to show chronological order
  const chartData = [...data].reverse().map((point) => ({
    ...point,
    timestamp: parseISO(point.time).getTime(),
  }));

  const formatXAxis = (timestamp: number) => {
    return format(new Date(timestamp), 'HH:mm');
  };

  const formatTooltip = (timestamp: number) => {
    return format(new Date(timestamp), 'MMM d, HH:mm:ss');
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
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
        <Legend />

        {showTemperature && (
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="temperature"
            name="Temperature (°C)"
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

        {showVoltage && (
          <Line
            yAxisId="humidity"
            type="monotone"
            dataKey="voltage"
            name="Voltage (V)"
            stroke="#22c55e"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
