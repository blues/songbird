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
import type { PowerPoint } from '@/types';

interface PowerChartProps {
  data: PowerPoint[];
  showVoltage?: boolean;
  showTemperature?: boolean;
  showMilliampHours?: boolean;
  height?: number;
}

export function PowerChart({
  data,
  showVoltage = true,
  showTemperature = true,
  showMilliampHours = true,
  height = 300,
}: PowerChartProps) {
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

        {/* Voltage Y-Axis (left) */}
        {showVoltage && (
          <YAxis
            yAxisId="voltage"
            domain={['auto', 'auto']}
            tickFormatter={(v) => `${v}V`}
            className="text-xs"
            stroke="#22c55e"
          />
        )}

        {/* Temperature/mAh Y-Axis (right) */}
        {(showTemperature || showMilliampHours) && (
          <YAxis
            yAxisId="secondary"
            orientation="right"
            domain={['auto', 'auto']}
            className="text-xs"
            stroke="#f97316"
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

        {showVoltage && (
          <Line
            yAxisId="voltage"
            type="monotone"
            dataKey="voltage"
            name="Voltage (V)"
            stroke="#22c55e"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}

        {showTemperature && (
          <Line
            yAxisId="secondary"
            type="monotone"
            dataKey="temperature"
            name="Board Temp (°C)"
            stroke="#f97316"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}

        {showMilliampHours && (
          <Line
            yAxisId="secondary"
            type="monotone"
            dataKey="milliamp_hours"
            name="Energy (mAh)"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
