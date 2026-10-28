import { useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { VStack } from '@astryxdesign/core/VStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Link } from '@astryxdesign/core/Link';
import { useAuth } from '../auth.jsx';
import { navigate, useLocation } from '../router.jsx';

// Only same-site paths are honoured as a post-login destination (no open redirects).
const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : null);

export default function AuthPage({ mode }) {
  const isRegister = mode === 'register';
  const { login, register } = useAuth();
  const { query } = useLocation();
  const next = safeNext(query.get('next'));
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (field) => (v) => setForm((f) => ({ ...f, [field]: v }));
  const status = (k) => (errors[k] ? { type: 'error', message: errors[k] } : undefined);

  // Client-side checks mirror the server's rules for instant feedback; the server re-validates everything.
  const validate = () => {
    const e = {};
    if (isRegister && form.name.trim().length < 2) e.name = 'Name must be at least 2 characters';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = 'Enter a valid email';
    if (isRegister ? form.password.length < 8 : !form.password) e.password = isRegister ? 'Use at least 8 characters' : 'Enter your password';
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
      const user = isRegister ? await register(form.name.trim(), form.email.trim(), form.password) : await login(form.email.trim(), form.password);
      navigate(next || (user.role === 'admin' ? '/admin' : '/'), { replace: true });
    } catch (err) {
      if (err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
      setFormError(err.message);
      setBusy(false);
    }
  };

  const otherHref = `${isRegister ? '/login' : '/register'}${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  return (
    <div className="auth">
      <Card padding={6}>
        <form onSubmit={onSubmit} noValidate>
          <VStack gap={5}>
            <VStack gap={1}>
              <Heading level={1}>{isRegister ? 'Create your account' : 'Sign in'}</Heading>
              <Text type="supporting">{next?.startsWith('/checkout') ? 'Sign in to continue to checkout.' : isRegister ? 'Track orders, save addresses and join flash deals.' : 'Welcome back.'}</Text>
            </VStack>
            {formError && <Banner status="error" title={formError} collapsible={false} />}
            <FormLayout defaultOptionality="required">
              {isRegister && <TextInput label="Full name" value={form.name} onChange={set('name')} autoComplete="name" status={status('name')} />}
              <TextInput label="Email" type="email" value={form.email} onChange={set('email')} autoComplete="email" status={status('email')} />
              <TextInput
                label="Password"
                type="password"
                value={form.password}
                onChange={set('password')}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                description={isRegister ? 'At least 8 characters' : undefined}
                status={status('password')}
              />
            </FormLayout>
            <Button label={isRegister ? 'Create account' : 'Sign in'} variant="primary" type="submit" size="lg" width="100%" isLoading={busy} />
            <Text type="supporting" size="sm">
              {isRegister ? 'Already have an account? ' : 'New here? '}
              <Link href={otherHref}>{isRegister ? 'Sign in' : 'Create an account'}</Link>
            </Text>
          </VStack>
        </form>
      </Card>
    </div>
  );
}
