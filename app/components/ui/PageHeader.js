/* The heading block at the top of every page: title, a short description of what the page is for, and the
   page's main actions. Actions sit on the right on wide screens and wrap under the title on phones. */

export default function PageHeader({ title, description = null, actions = null }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </header>
  );
}
