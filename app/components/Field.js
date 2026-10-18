/* Label + control + hint/error wrapper used by the lead forms. */

export default function Field({ id, label, required = false, error, hint, group = false, className = "", children }) {
  const message = error ? (
    <p className="field-error" id={`${id}-error`} role="alert">
      {error}
    </p>
  ) : hint ? (
    <p className="field-hint" id={`${id}-hint`}>
      {hint}
    </p>
  ) : null;

  return (
    <div className={`field ${className}`}>
      {group ? (
        <span className="field-label" id={id}>
          {label}
          {required && <span className="required"> *</span>}
        </span>
      ) : (
        <label htmlFor={id}>
          {label}
          {required && <span className="required"> *</span>}
        </label>
      )}
      {children}
      {message}
    </div>
  );
}

// Props to spread on an input/select/textarea so errors and hints are announced.
export function fieldProps(id, error, hint) {
  return {
    id,
    "aria-invalid": error ? "true" : undefined,
    "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined,
  };
}