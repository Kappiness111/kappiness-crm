// Maps each status to an existing badge colour class so no new CSS is needed.
const CLASS_BY_STATUS = {
  Enquiry: "new",
  "Yet to Confirm": "follow-up",
  "Will Inform": "contacted",
  Confirmed: "converted",
};

export default function StatusBadge({ status }) {
  const statusClass = CLASS_BY_STATUS[status] || String(status || "").toLowerCase().replaceAll(" ", "-");

  return (
    <span className={`status-badge status-${statusClass}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}