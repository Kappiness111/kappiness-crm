/* Phone-number normalisation, mirroring public.normalize_phone() in migration 20261125120000 exactly.
   Used for instant feedback only (Add Lead form, search). The database is the authority: it stores
   clients.phone_normalized and suggests matching clients (shared numbers are allowed). tests/phone.test.mjs checks both
   implementations against the same examples as supabase/tests/client_management_day24_test.sql.

   Rules (the clinic is in India; numbers abroad must be entered with + and their country code):
     spaces, hyphens, dots, brackets and a trailing extension (ext / x / #) are ignored;
     "+<digits>" or "00<digits>"   -> "+<digits>" (8 to 15 digits); "+91 0XXXXXXXXXX" -> "+91XXXXXXXXXX"
     10 digits                     -> "+91" + digits
     11 digits starting with 0     -> "+91" + last 10
     12 digits starting with 91    -> "+" + digits
     other 7 to 15 digits          -> digits unchanged (no country assumed: only matches the very same digits)
     anything else                 -> null (not a phone number) */
export function normalizePhone(phone) {
  if (phone === null || phone === undefined) return null;
  let value = String(phone).trim().replace(/\s*(ext\.?|extension|x|#)\s*[0-9]{1,6}\s*$/i, "");
  // International when the first digit-or-plus character is "+" (same rule as the SQL): "(+44) ...", "Tel: +44 ..."
  // and leading tabs / non-breaking spaces do not hide the country code.
  let plus = value.replace(/[^0-9+]/g, "").startsWith("+");
  let digits = value.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (!plus && digits.startsWith("00")) {
    plus = true;
    digits = digits.slice(2);
  }
  if (plus) {
    if (digits.length === 13 && digits.startsWith("910")) digits = `91${digits.slice(3)}`;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return digits;
  return null;
}

// Same number, whatever the formatting. Unrecognisable numbers never match.
export function samePhone(a, b) {
  const left = normalizePhone(a);
  return Boolean(left) && left === normalizePhone(b);
}

// "?…3210" style mask for places where the full number is not needed.
export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length > 4 ? `…${digits.slice(-4)}` : digits;
}
