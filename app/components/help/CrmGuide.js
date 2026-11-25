"use client";

import { useState } from "react";
import Dialog from "../Dialog";
import Icon from "../Icon";
import StatusBadge from "../StatusBadge";
import { Badge } from "../ui/StatusBadges";

/* Help: opened from "How it works" in the header on every staff page.
   Five everyday jobs, each explained in plain words beside a small preview made from the CRM's own buttons,
   badges and slots, so people recognise them on screen. The button under each topic opens that place. */

// Where each topic lives, for pages outside "/" (the dashboard opens forms in place).
export const STEP_HREF = {
  "add-lead": "/?view=Leads",
  "follow-up": "/?view=Follow%20Ups",
  book: "/",
  "follow-ups": "/follow-ups",
  leave: "/schedule",
};

function Field({ label, value, wide = false }) {
  return (
    <div className={`hp-field ${wide ? "is-wide" : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

const TOPICS = [
  {
    id: "add-lead",
    icon: "plus",
    title: "Adding a new lead",
    go: "Add a lead",
    body: (
      <>
        <p>
          When someone calls, messages or walks in, press <strong>Add lead</strong> on the dashboard. You only need their
          name, phone number and where they heard about the clinic. Email and notes can wait.
        </p>
        <p>New leads start as <StatusBadge status="New Lead" />.</p>
      </>
    ),
    preview: (
      <div className="hp-card">
        <div className="hp-card-title">Add Lead</div>
        <Field label="Full name *" value="Meera Nair" />
        <Field label="Mobile number *" value="+91 98470 12345" />
        <Field label="Lead source *" value="Instagram" />
        <div className="hp-card-foot">
          <span className="btn btn-sm btn-primary" aria-hidden="true">
            Save lead
          </span>
        </div>
      </div>
    ),
  },
  {
    id: "follow-up",
    icon: "phone",
    title: "Calling leads back",
    go: "Open follow-up calls",
    body: (
      <>
        <p>
          After each call, open the lead, update its status and pick when to call next. The status shows where they are:
        </p>
        <p className="hp-flow">
          <StatusBadge status="New Lead" /> <span>then</span> <StatusBadge status="Contacted" /> <span>then</span>{" "}
          <StatusBadge status="Interested" /> <span>then</span> <StatusBadge status="Awaiting Confirmation" /> <span>then</span>{" "}
          <StatusBadge status="Confirmed" />
        </p>
        <p>
          Calls due today appear at the top of the dashboard. If one is missed it turns red until someone calls. A lead
          who isn&apos;t going ahead is marked <StatusBadge status="Not Interested" /> or <StatusBadge status="Lost Lead" />.
        </p>
      </>
    ),
    preview: (
      <div className="hp-card hp-todo">
        <span className="home-chip is-danger" aria-hidden="true">
          1 overdue call <Icon name="chevronRight" />
        </span>
        <span className="home-chip" aria-hidden="true">
          3 calls due today <Icon name="chevronRight" />
        </span>
        <span className="home-chip" aria-hidden="true">
          2 leads waiting to confirm <Icon name="chevronRight" />
        </span>
      </div>
    ),
  },
  {
    id: "book",
    icon: "calendar",
    title: "Booking a session",
    go: "Go to the dashboard",
    body: (
      <>
        <p>
          When a lead agrees, choose their psychologist and set them to <StatusBadge status="Confirmed" />. Their client
          file is made automatically, so nothing is typed twice.
        </p>
        <p>
          Then press <strong>Book appointment</strong> and pick a time. White times are free. A dashed time is held for
          someone who hasn&apos;t confirmed yet, and grey is taken.
        </p>
      </>
    ),
    preview: (
      <div className="hp-card">
        <div className="hp-card-title">Tuesday 25 November</div>
        <div className="slot-grid">
          <span className="slot" aria-hidden="true">
            10:00 AM
          </span>
          <span className="slot active" aria-hidden="true">
            11:00 AM
          </span>
          <span className="slot slot-tentative" aria-hidden="true">
            12:00 PM <span className="slot-tag">Tentative</span>
          </span>
          <span className="slot slot-booked" aria-hidden="true">
            2:00 PM <span className="slot-tag">Booked</span>
          </span>
          <span className="slot" aria-hidden="true">
            3:00 PM
          </span>
        </div>
      </div>
    ),
  },
  {
    id: "follow-ups",
    icon: "bell",
    title: "Follow-ups and reminders",
    go: "Open Follow-ups",
    body: (
      <>
        <p>
          After a session the psychologist may recommend another one. It shows up under <strong>Follow-ups</strong> for
          reception to book.
        </p>
        <p>
          Each booking gets two reminders. Note when you sent each one and what the client said: confirmed, wants to
          reschedule, or no reply.
        </p>
      </>
    ),
    preview: (
      <div className="hp-card hp-rows">
        <div>
          <span>Reminder 1</span>
          <Badge tone="success">Delivered</Badge>
        </div>
        <div>
          <span>Reminder 2</span>
          <Badge tone="neutral">Pending</Badge>
        </div>
        <div>
          <span>Client said</span>
          <Badge tone="success">Confirmed</Badge>
        </div>
      </div>
    ),
  },
  {
    id: "leave",
    icon: "clock",
    title: "Leave and free slots",
    go: "Open Availability & Leave",
    body: (
      <>
        <p>
          <strong>Availability &amp; Leave</strong> shows every psychologist&apos;s day as numbered slots: who is booked,
          what is free and who is away.
        </p>
        <p>
          If someone is off, press <strong>Mark on leave</strong> on their card. Their free slots close for that day, so
          nobody gets booked by mistake.
        </p>
      </>
    ),
    preview: (
      <div className="hp-card hp-rows">
        <div>
          <span>
            <b className="hp-slotno">S1</b> Vaishnavi · 11 am
          </span>
          <Badge tone="success">Confirmed</Badge>
        </div>
        <div>
          <span>
            <b className="hp-slotno">S2</b> Akhil · 12 pm
          </span>
          <Badge tone="warning">Will inform</Badge>
        </div>
        <div>
          <span className="muted">
            <b className="hp-slotno">S3</b> + Book 1 pm
          </span>
        </div>
      </div>
    ),
  },
];

export function GuideContent({ onGo }) {
  const [active, setActive] = useState(TOPICS[0].id);
  const topic = TOPICS.find((item) => item.id === active) || TOPICS[0];
  return (
    <div className="hp">
      <nav className="hp-nav" aria-label="Help topics">
        {TOPICS.map((item) => (
          <button key={item.id} type="button" aria-current={item.id === active ? "true" : undefined} onClick={() => setActive(item.id)}>
            <Icon name={item.icon} />
            {item.title}
          </button>
        ))}
      </nav>
      <article className="hp-topic" aria-live="polite">
        <h3>{topic.title}</h3>
        <div className="hp-body">{topic.body}</div>
        <div className="hp-preview" aria-hidden="true">
          {topic.preview}
        </div>
        {onGo ? (
          <button type="button" className="btn btn-primary btn-sm hp-go" onClick={() => onGo(topic.id)}>
            {topic.go}
          </button>
        ) : null}
      </article>
    </div>
  );
}

// Header button: opens help from any staff page. onStep(id) goes to the matching screen.
export function HelpButton({ onStep }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm help-btn" onClick={() => setOpen(true)} title="How the CRM works">
        <Icon name="info" />
        <span className="help-label">How it works</span>
      </button>
      {open && (
        <Dialog
          titleId="crm-guide-title"
          title="How the CRM works"
          subtitle="The everyday jobs, in the order they usually happen."
          size="lg"
          onClose={() => setOpen(false)}
        >
          <div className="modal-body hp-modal">
            <GuideContent
              onGo={
                onStep
                  ? (id) => {
                      setOpen(false);
                      onStep(id);
                    }
                  : null
              }
            />
          </div>
        </Dialog>
      )}
    </>
  );
}
