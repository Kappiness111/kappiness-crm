export default function PriorityChip({ priority = "Normal" }) {
  return <span className={`priority-chip priority-${priority.toLowerCase()}`}>{priority} priority</span>;
}