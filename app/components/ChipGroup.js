/* Single-choice pill buttons (priority, preferred contact method, ...). */

export default function ChipGroup({ labelledBy, options, value, onChange }) {
  return (
    <div className="chip-group" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option) => (
        <button
          type="button"
          key={option}
          role="radio"
          aria-checked={value === option}
          className={`chip ${value === option ? "active" : ""}`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}