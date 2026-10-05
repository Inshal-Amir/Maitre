import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Cpu, KeyRound, ShieldCheck } from 'lucide-react';
import brand from '@brand/brand.json';
import { api } from '../api';
import { ErrorNote, useSession } from '../App';

const POINTS = [
  { icon: Cpu, title: 'Our own model on our own GPU', text: 'Qwen3.6-35B-A3B, served from the Zehnora GPU server — your requests never go to a third-party AI provider.' },
  { icon: KeyRound, title: 'OpenAI-compatible API', text: 'Use the OpenAI SDK, LangChain or curl with your Zehnora key and base URL.' },
  { icon: ShieldCheck, title: 'Credits you can see', text: 'Every request is reserved, charged on real usage and listed in your history.' },
];

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(mode === 'login' ? '/auth/login' : '/auth/register', { email, password });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth-hero">
        <div className="logo"><span className="mark">{brand.productName[0]}</span>{brand.productName}<span className="logo-sub">Console</span></div>
        <div>
          <h2>Build with an AI that runs on our own hardware.</h2>
          <p>Create API keys, follow your usage and try the model in the playground.</p>
          <div className="auth-points">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <div key={title} className="auth-point">
                <span className="ic"><Icon size={17} /></span>
                <div><b>{title}</b><span>{text}</span></div>
              </div>
            ))}
          </div>
        </div>
        <div className="foot">{brand.productName} · api and console at dubg.dev</div>
      </aside>
      <main className="auth-side">
        <form className="auth-card" onSubmit={submit}>
          <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="muted">{mode === 'login' ? `Sign in to the ${brand.productName} Console.` : `Start building with ${brand.productName}.`}</p>
          <label>Email<input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
          <label>Password
            <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 10 : undefined}
                   placeholder={mode === 'register' ? 'At least 10 characters' : ''} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {mode === 'register' && <p className="muted small">New accounts start with zero credits. {brand.creditsNotice}</p>}
          <ErrorNote error={error} />
          <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <p className="switch">
            {mode === 'login' ? <>New to {brand.productName}? <Link to="/register">Create an account</Link></> : <>Already have an account? <Link to="/">Sign in</Link></>}
          </p>
          {mode === 'login' && <p className="muted tiny fine">Forgot your password? Password reset needs email delivery, which is not set up yet — ask the administrator.</p>}
        </form>
      </main>
    </div>
  );
}
