/* Lead status as a compact badge. Colour carries meaning only:
   neutral = new enquiry, warning = waiting on the client, info = client will get back,
   success = confirmed, danger = lost. The text is always shown, so colour is never the only signal. */

export const STATUS_TONE = {
  Enquiry: "neutral",
  "Yet to Confirm": "warning",
  "Will Inform": "info",
  Confirmed: "success",
  Lost: "danger",
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
