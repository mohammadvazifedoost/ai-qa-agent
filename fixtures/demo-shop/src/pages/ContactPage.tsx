import { useState, type FormEvent } from 'react';
import { sendMessage } from '../api/catalog';
import { Button } from '../components/Button';

export function ContactPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!name.trim()) next.name = 'Enter your name';
    if (!/^\S+@\S+\.\S+$/.test(email)) next.email = 'Enter a valid email address';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSending(true);
    await sendMessage({ name, email, message });
    setSending(false);
    setSent(true);
  }

  if (sent) {
    return (
      <section className="auth">
        <h1>Message sent</h1>
        <p className="muted">Thanks {name.trim()}, we reply within two working days.</p>
      </section>
    );
  }

  return (
    <section className="auth">
      <h1>Contact us</h1>
      <form onSubmit={submit} noValidate aria-label="Contact">
        <label htmlFor="name">Name</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
        {errors.name && <p className="error">{errors.name}</p>}
        <label htmlFor="contact-email">Email</label>
        <input
          id="contact-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={!!errors.email}
        />
        {errors.email && <p className="error">{errors.email}</p>}
        <label htmlFor="message">Message</label>
        <textarea id="message" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} />
        <Button type="submit" disabled={sending}>
          {sending ? 'Sending…' : 'Send message'}
        </Button>
      </form>
    </section>
  );
}
