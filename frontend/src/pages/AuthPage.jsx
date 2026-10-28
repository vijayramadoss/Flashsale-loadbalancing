import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { Link, navigate } from '../router.jsx';

export default function AuthPage({ mode }) {
  const isRegister = mode === 'register';
  const { login, register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  // Client-side checks mirror the server's rules for instant feedback;
  // the server re-validates everything regardless.
  const validate = () => {
    const e = {};
    if (isRegister && form.name.trim().length < 2) e.name = 'Name must be at least 2 characters';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = 'Enter a valid email';
    if (isRegister ? form.password.length < 8 : !form.password) {
      e.password = isRegister ? 'Password must be at least 8 characters' : 'Password is required';
    }
    return e;
  };

  const onSubmit = async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const e = validate();
    setErrors(e);
    setFormError('');
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const user = isRegister
        ? await register(form.name.trim(), form.email.trim(), form.password)
        : await login(form.email.trim(), form.password);
      navigate(user.role === 'admin' ? '/admin' : '/', { replace: true });
    } catch (err) {
      if (err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      setFormError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card auth" onSubmit={onSubmit} noValidate>
      <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
      <p className="muted">{isRegister ? 'You need an account to join the flash sale.' : 'Log in to take part in the sale.'}</p>

      {isRegister && (
        <Field label="Name" error={errors.name}>
          <input id="name" autoComplete="name" value={form.name} onChange={set('name')} aria-invalid={!!errors.name} />
        </Field>
      )}
      <Field label="Email" error={errors.email}>
        <input id="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} />
      </Field>
      <Field label="Password" error={errors.password}>
        <input
          id="password"
          type="password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          value={form.password}
          onChange={set('password')}
          aria-invalid={!!errors.password}
        />
      </Field>

      {formError && <p className="err" role="alert">{formError}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {isRegister ? 'Sign up' : 'Log in'}
      </button>
      <p className="muted small center">
        {isRegister ? (
          <>Already have an account? <Link to="/login">Log in</Link></>
        ) : (
          <>New here? <Link to="/register">Create an account</Link></>
        )}
      </p>
    </form>
  );
}

function Field({ label, error, children }) {
  const id = children.props.id;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <span className="field-err">{error}</span>}
    </div>
  );
}
