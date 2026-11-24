"use client";

import { useState } from "react";
import Dialog from "../Dialog";
import Icon from "../Icon";
import { Badge, LeadStatusBadge } from "../ui/StatusBadges";

/* "How it works": opened from the Help button in the header on every staff page.
   Two parts: the client journey (the real status names, in order) and short answers to "How do I…?",
   written with the exact button names people see on screen. */

// Where each task lives, for pages outside "/" (the dashboard opens forms in place).
export const STEP_HREF = {
  "add-lead": "/?view=Leads",
  "follow-up": "/?view=Follow%20Ups",
  confirm: "/?view=Leads",
  book: "/",
  leave: "/schedule",
  "follow-ups": "/follow-ups",
};

const JOURNEY = [
  { lead: "Enquiry", who: "Reception", note: "First call or message" },
  { lead: "Yet to Confirm", who: "Reception", note: "Interested, deciding" },
  { lead: "Will Inform", who: "Reception", note: "Client will get back" },
  { lead: "Confirmed", who: "Reception", note: "Becomes a client" },
  { label: "Booked", who: "Reception", note: "Slot on the schedule" },
  { label: "Session", who: "Psychologist", note: "Attended or missed" },
  { label: "Follow-up", who: "Both", note: "Next session + reminders" },
];

const Key = ({ children }) => <span className="ui-key">{children}</span>;

const TASKS = [
  {
    id: "add-lead",
    q: "Add someone who just called",
    steps: [
      <>On the Dashboard, select <Key>Add lead</Key>.</>,
      <>Fill in their name, mobile number and how they found the clinic.</>,
      <>Select <Key>Save lead</Key>. They now appear under Leads as <LeadStatusBadge status="Enquiry" />.</>,
    ],
  },
  {
    id: "follow-up",
    q: "Update a lead after calling them back",
    steps: [
      <>Open <Key>Leads</Key> and select the person.</>,
      <>Change their status and set the next follow-up time.</>,
      <>Calls that are due show in the dashboard&apos;s To do line; late ones turn red.</>,
    ],
  },
  {
    id: "confirm",
    q: "Turn a lead into a client",
    steps: [
      <>Open the lead and choose their psychologist.</>,
      <>Set the status to <LeadStatusBadge status="Confirmed" />.</>,
      <>Their client profile is created automatically. Nothing needs to be typed again.</>,
    ],
  },
  {
    id: "book",
    q: "Book an appointment",
    steps: [
      <>On the Dashboard, find the psychologist&apos;s card and select a free slot (<Key>+ Book</Key>).</>,
      <>Choose the client and save. The booking shows as <Badge tone="warning">Will inform</Badge> until the client confirms.</>,
      <>When they confirm, select <Key>✓</Key> on the slot. To move it, select <Key>↻</Key>.</>,
    ],
  },
  {
    id: "leave",
    q: "Mark a psychologist on leave",
    steps: [
      <>On the psychologist&apos;s card, select <Key>Mark on leave</Key>.</>,
      <>Their free slots for that day close, and they show under On leave.</>,
    ],
  },
  {
    id: "follow-ups",
    q: "Book a follow-up and record reminders",
    steps: [
      <>Open <Key>Follow-ups</Key>. Recommended follow-ups that are not booked yet are listed there.</>,
      <>Select one to book it, then record Reminder 1 and Reminder 2: whether each was sent and what the client said.</>,
    ],
  },
];

function GuideContent({ onGo }) {
  const [openId, setOpenId] = useState(TASKS[0].id);
  return (
    <div className="hw">
      <section aria-labelledby="hw-journey">
        <h3 id="hw-journey" className="hw-h">The client journey</h3>
        <ol className="hw-track">
          {JOURNEY.map((stage) => (
            <li key={stage.lead || stage.label}>
              <span className="hw-dot" aria-hidden="true" />
              {stage.lead ? <LeadStatusBadge status={stage.lead} /> : <span className="hw-stage">{stage.label}</span>}
              <span className="hw-note">{stage.note}</span>
              <span className="hw-who">{stage.who}</span>
            </li>
          ))}
        </ol>
        <p className="hw-aside">
          A lead can be marked <LeadStatusBadge status="Lost" /> at any point before Confirmed. Lost and Confirmed are final.
        </p>
      </section>

      <section aria-labelledby="hw-tasks">
        <h3 id="hw-tasks" className="hw-h">How do I…</h3>
        <ul className="hw-tasks">
          {TASKS.map((task) => {
            const open = openId === task.id;
            return (
              <li key={task.id} className={open ? "is-open" : ""}>
                <button type="button" className="hw-q" aria-expanded={open} onClick={() => setOpenId(open ? null : task.id)}>
                  {task.q}
                  <Icon name={open ? "chevronDown" : "chevronRight"} />
                </button>
                {open && (
                  <div className="hw-a">
                    <ol>
                      {task.steps.map((step, index) => (
                        <li key={index}>{step}</li>
                      ))}
                    </ol>
                    {onGo ? (
                      <button type="button" className="btn btn-sm" onClick={() => onGo(task.id)}>
                        Take me there <Icon name="arrowRight" />
                      </button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

// Header button: opens the guide from any staff page. onStep(id) goes to the matching screen.
export function HelpButton({ onStep }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm help-btn" onClick={() => setOpen(true)} title="How the CRM works">
        <Icon name="info" />
        <span className="help-label">How it works</span>
      </button>
      {open && (
        <Dialog titleId="crm-guide-title" title="How the CRM works" size="lg" onClose={() => setOpen(false)}>
          <div className="modal-body">
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
