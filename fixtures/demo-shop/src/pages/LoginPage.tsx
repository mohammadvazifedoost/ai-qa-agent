import { useState, type FormEvent } from 'react';
import { login } from '../api/catalog';
import { Button } from '../components/Button';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) next.email = 'Enter a valid email address';
    if (password.length < 8) next.password = 'Password must be at least 8 characters';
    setErrors(next);
    if (Object.keys(next).length) return;
    setLoading(true);
    const res = await login(email, password);
    setLoading(false);
    if (res.ok) setUser(res.name ?? email);
    else setErrors({ form: 'Invalid email or password' });
  }

  if (user) {
    return (
      <section className="auth">
        <h1>Welcome back, {user}</h1>
      </section>
    );
  }

  return (
    <section className="auth">
      <h1>Sign in</h1>
      <form onSubmit={submit} noValidate aria-label="Sign in">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? 'email-error' : undefined}
        />
        {errors.email && (
          <p id="email-error" className="error">
            {errors.email}
          </p>
        )}
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!errors.password}
          aria-describedby={errors.password ? 'password-error' : undefined}
        />
        {errors.password && (
          <p id="password-error" className="error">
            {errors.password}
          </p>
        )}
        {errors.form && (
          <p role="alert" className="error">
            {errors.form}
          </p>
        )}
        <Button type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </section>
  );
}
