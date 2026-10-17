export default function StatusBadge({ status }) {
  const statusClass = status.toLowerCase().replaceAll(" ", "-");

  return (
    <span className={`status-badge status-${statusClass}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}