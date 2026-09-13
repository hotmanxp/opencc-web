interface StatusDotProps {
  installed: boolean;
}

export default function StatusDot({ installed }: StatusDotProps) {
  const color = installed ? 'var(--success)' : 'var(--error)';
  const shadow = installed ? '0 0 8px rgba(34, 197, 94, 0.6)' : '0 0 8px rgba(239, 68, 68, 0.6)';

  return (
    <span
      className="inline-block w-3 h-3 rounded-full"
      style={{ backgroundColor: color, boxShadow: shadow }}
    />
  );
}