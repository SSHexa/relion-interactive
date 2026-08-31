import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Box, Typography, useTheme } from '@mui/material';

export interface FSCDataPoint {
  resolution: number;
  fsc: number;
  type?: 'corrected' | 'masked' | 'unmasked';
}

interface FSCChartProps {
  data: FSCDataPoint[];
  finalResolution?: number;
  title?: string;
  height?: number;
  showMultipleCurves?: boolean; // For PostProcess with masked/unmasked
}

const FSCChart: React.FC<FSCChartProps> = ({
  data,
  finalResolution,
  title = 'FSC Curve',
  height = 300,
  showMultipleCurves = false,
}) => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  // Separate data by type if multiple curves
  const correctedData = data.filter((d) => !d.type || d.type === 'corrected');
  const maskedData = data.filter((d) => d.type === 'masked');
  const unmaskedData = data.filter((d) => d.type === 'unmasked');

  // Combine for single curve display
  const chartData = showMultipleCurves
    ? data.reduce((acc, point) => {
        const existing = acc.find((p) => p.resolution === point.resolution);
        if (existing) {
          if (point.type === 'masked') existing.maskedFsc = point.fsc;
          else if (point.type === 'unmasked') existing.unmaskedFsc = point.fsc;
          else existing.fsc = point.fsc;
        } else {
          const newPoint: Record<string, number> = { resolution: point.resolution };
          if (point.type === 'masked') newPoint.maskedFsc = point.fsc;
          else if (point.type === 'unmasked') newPoint.unmaskedFsc = point.fsc;
          else newPoint.fsc = point.fsc;
          acc.push(newPoint);
        }
        return acc;
      }, [] as Record<string, number>[])
    : correctedData.map((d) => ({ resolution: d.resolution, fsc: d.fsc }));

  // Sort by resolution (descending for display)
  chartData.sort((a, b) => b.resolution - a.resolution);

  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
  const textColor = isDark ? '#94A3B8' : '#666';

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.primary' }}>
        {title}
      </Typography>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 30 }}>
          <CartesianGrid strokeDasharray="1 4" stroke={gridColor} vertical={false} />
          <XAxis
            dataKey="resolution"
            reversed
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) => v.toFixed(1)}
            label={{
              value: 'Resolution (Å)',
              position: 'bottom',
              offset: 10,
              style: { fill: textColor },
            }}
            tick={{ fill: textColor, fontSize: 11 }}
          />
          <YAxis
            domain={[0, 1.05]}
            tickFormatter={(v) => v.toFixed(1)}
            label={{
              value: 'FSC',
              angle: -90,
              position: 'insideLeft',
              style: { fill: textColor },
            }}
            tick={{ fill: textColor, fontSize: 11 }}
          />
          <Tooltip
            formatter={(value: number) => value.toFixed(3)}
            labelFormatter={(label: number) => `${label.toFixed(2)} Å`}
            contentStyle={{
              backgroundColor: isDark ? 'rgba(13,21,38,0.9)' : '#fff',
              border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : '#e0e0e0'}`,
              borderRadius: 10,
              backdropFilter: isDark ? 'blur(16px)' : 'none',
              boxShadow: isDark
                ? '0 0 0 1px rgba(99,102,241,0.2), 0 8px 24px rgba(0,0,0,0.4)'
                : '0 4px 16px rgba(0,0,0,0.08)',
              padding: '8px 12px',
            }}
            labelStyle={{ color: isDark ? '#F1F5F9' : '#333', fontWeight: 600 }}
          />
          {/* Only show legend for multiple curves (PostProcess) */}
          {showMultipleCurves && <Legend verticalAlign="top" />}

          {/* FSC = 0.143 threshold line */}
          <ReferenceLine
            y={0.143}
            stroke="#F43F5E"
            strokeDasharray="5 5"
            label={{
              value: 'FSC=0.143',
              position: 'right',
              fill: '#F43F5E',
              fontSize: 10,
              fontWeight: 600,
            }}
          />

          {/* FSC = 0.5 reference line */}
          <ReferenceLine
            y={0.5}
            stroke="#FBBF24"
            strokeDasharray="3 3"
            label={{
              value: 'FSC=0.5',
              position: 'right',
              fill: '#FBBF24',
              fontSize: 10,
            }}
          />

          {/* Final resolution marker */}
          {finalResolution && (
            <ReferenceLine
              x={finalResolution}
              stroke="#34D399"
              strokeDasharray="3 3"
              label={{
                value: `${finalResolution.toFixed(1)} Å`,
                position: 'top',
                fill: '#34D399',
                fontSize: 11,
                fontWeight: 'bold',
              }}
            />
          )}

          {/* Main FSC curve */}
          {!showMultipleCurves && (
            <Line
              type="monotone"
              dataKey="fsc"
              stroke={isDark ? '#22D3EE' : '#3B82F6'}
              strokeWidth={2.5}
              dot={false}
              name="Gold-standard FSC"
            />
          )}

          {/* Multiple curves for PostProcess */}
          {showMultipleCurves && (
            <>
              {maskedData.length > 0 && (
                <Line
                  type="monotone"
                  dataKey="maskedFsc"
                  stroke="#34D399"
                  strokeWidth={2.5}
                  dot={false}
                  name="Masked FSC"
                />
              )}
              {unmaskedData.length > 0 && (
                <Line
                  type="monotone"
                  dataKey="unmaskedFsc"
                  stroke="#FBBF24"
                  strokeWidth={2}
                  dot={false}
                  name="Unmasked FSC"
                />
              )}
              {correctedData.length > 0 && (
                <Line
                  type="monotone"
                  dataKey="fsc"
                  stroke={isDark ? '#22D3EE' : '#3B82F6'}
                  strokeWidth={2.5}
                  dot={false}
                  name="Corrected FSC"
                />
              )}
            </>
          )}
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
};

export default FSCChart;
