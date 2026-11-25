"use client";

import { useState } from "react";
import Dialog from "../Dialog";
import styles from "./followups.module.css";
import { MESSAGE_TEMPLATES, whatsappMessageLink } from "../../lib/followUpMessages";

/* Pick a prepared message, edit it, open WhatsApp. Nothing is sent from the CRM and nothing is recorded:
   staff update the communication status themselves after sending. */
export default function WhatsAppMessageDialog({ followUp, phone, psychologistName = "", onClose }) {
  const first = MESSAGE_TEMPLATES[0];
  const [templateId, setTemplateId] = useState(first.id);
  const [text, setText] = useState(() => first.build(followUp, psychologistName));

  function choose(id) {
    const template = MESSAGE_TEMPLATES.find((item) => item.id === id);
    setTemplateId(id);
    setText(template.build(followUp, psychologistName));
  }

  return (
    <Dialog
      titleId="wa-dialog-title"
      title="WhatsApp message"
      subtitle={`${followUp.client_name || "Client"} · ${phone}`}
      onClose={onClose}
      small
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <a className="btn btn-primary" href={whatsappMessageLink(phone, text.trim())} target="_blank" rel="noopener noreferrer" onClick={onClose}>
            Open WhatsApp
          </a>
        </>
      }
    >
      <div className="modal-body" style={{ display: "grid", gap: 12 }}>
        <fieldset className="field">
          <legend className="field-label">Message</legend>
          <div className={styles.choiceRow}>
            {MESSAGE_TEMPLATES.map((item) => (
              <button key={item.id} type="button" className={`chip ${templateId === item.id ? "active" : ""}`} aria-pressed={templateId === item.id} onClick={() => choose(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="wa-text">Text (you can edit it)</label>
          <textarea id="wa-text" rows={5} maxLength={1000} value={text} onChange={(event) => setText(event.target.value)} />
        </div>
        <p className={styles.hint} style={{ margin: 0 }}>
          Opening WhatsApp does not record anything. After you send the message, come back and choose <strong>Message Sent</strong>.
        </p>
      </div>
    </Dialog>
  );
}
