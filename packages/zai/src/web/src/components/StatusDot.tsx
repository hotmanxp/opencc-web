interface StatusDotProps {
  installed: boolean;
}

export default function StatusDot({ installed }: StatusDotProps) {
  const color = installed ? 'var(--success)' : 'var(--error)';
  const shadow = installed ? '0 0 8px rgba(34, 197, 94, 0.6)' : '0 0 8px rgba(239, 68, 68, 0.6)';

  return (
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: '50%',
        backgroundColor: color,
        boxShadow: shadow,
      }}
    />
  );
}
