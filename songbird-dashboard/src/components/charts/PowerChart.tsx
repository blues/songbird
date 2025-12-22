import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import type { PowerPoint } from '@/types';

interface PowerChartProps {
  data: PowerPoint[];
  height?: number;
}

export function PowerChart({ data, height = 300 }: PowerChartProps) {
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

  const tooltipStyle = {
    backgroundColor: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '8px',
  };

  // Check which data is available
  const hasVoltage = chartData.some((d) => d.voltage !== undefined);
  const hasMilliampHours = chartData.some((d) => d.milliamp_hours !== undefined);

  const chartHeight = Math.floor(height / 2) - 8;

  return (
    <div className="space-y-4">
      {/* Info note about power monitoring */}
      <p className="text-xs text-muted-foreground italic">
        Power monitoring is only performed when the device is battery powered and not plugged in or charging over USB.
      </p>

      {/* Voltage Chart */}
      {hasVoltage && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-green-500">Battery Voltage</h4>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
              />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={(v) => `${v.toFixed(1)}V`}
                className="text-xs"
                stroke="#22c55e"
                width={50}
              />
              <Tooltip labelFormatter={formatTooltip} contentStyle={tooltipStyle} />
              <Line
                type="monotone"
                dataKey="voltage"
                name="Voltage (V)"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Energy Chart */}
      {hasMilliampHours && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-blue-500">Energy Consumption (mAh)</h4>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                className="text-xs"
                stroke="currentColor"
              />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={(v) => `${v.toFixed(2)}`}
                className="text-xs"
                stroke="#3b82f6"
                width={50}
              />
              <Tooltip labelFormatter={formatTooltip} contentStyle={tooltipStyle} />
              <Line
                type="monotone"
                dataKey="milliamp_hours"
                name="Energy (mAh)"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!hasVoltage && !hasMilliampHours && (
        <div className="h-[100px] flex items-center justify-center">
          <span className="text-muted-foreground">No power data available</span>
        </div>
      )}
    </div>
  );
}
