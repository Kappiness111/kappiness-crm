/* Lead status as a compact badge. Colour carries meaning only:
   neutral = new lead, info = in conversation, warning = waiting on a follow-up or the client,
   success = confirmed, danger = closed without converting. The text is always shown, so colour is never the
   only signal. */

export const STATUS_TONE = {
  "New Lead": "neutral",
  Contacted: "info",
  Interested: "info",
  "Follow-up Required": "warning",
  "Awaiting Confirmation": "warning",
  Confirmed: "success",
  "Not Interested": "danger",
  "Lost Lead": "danger",
};

export function statusTone(status) {
  return STATUS_TONE[status] || "neutral";
}

export default function StatusBadge({ status }) {
  return (
    <span className={`status-badge tone-${statusTone(status)}`}>
      <span className="status-dot" aria-hidden="true" />
      {status}
    </span>
  );
}
