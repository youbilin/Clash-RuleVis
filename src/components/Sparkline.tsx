interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({ data, width = 48, height = 15, color = 'var(--accent)' }: SparklineProps) {
  const points = data.length ? data.slice(-24) : [0, 0];
  const max = Math.max(1, ...points);
  const step = width / Math.max(1, points.length - 1);
  const coords = points.map((value, index) => {
    const x = index * step;
    const y = height - 1 - (Math.max(0, value) / max) * (height - 3);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      <polygon points={area} fill={color} opacity="0.08" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" opacity="0.72" />
    </svg>
  );
}
