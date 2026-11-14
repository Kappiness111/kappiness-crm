"use client";

/* Section tabs at the top of a page (for example Leads | Follow-up calls). Uses the existing .tabs/.tab styles.
   items: [{ id, label, count? }]; onSelect(id) switches the view or route. */
export default function PageTabs({ items, activeId, onSelect, label }) {
  return (
    <div className="tabs page-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={item.id === activeId}
          onClick={() => item.id !== activeId && onSelect(item.id)}
        >
          {item.label}
          {item.count !== undefined && item.count !== null ? <span className="tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
