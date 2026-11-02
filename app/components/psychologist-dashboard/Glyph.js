/* A few extra line icons the shared Icon component does not have. Same stroke style. */
const GLYPHS = {
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  logout: (
    <>
      <path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9" />
      <path d="M15 8l4 4-4 4M19 12H9" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c0-3.8 3.4-6 7.5-6s7.5 2.2 7.5 6" />
    </>
  ),
};

export default function Glyph({ name, className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}