import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Cpu, KeyRound, ShieldCheck } from 'lucide-react';
import brand from '@brand/brand.json';
import { api } from '../api';
import { ErrorNote, useSession } from '../App';

const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'The Google sign-in expired or was opened twice. Please try again.',
  google_token: 'Google did not confirm the sign-in. Please try again.',
  google_unverified_email: 'Your Google email address is not verified, so it cannot be used to sign in.',
  google_not_configured: 'Sign in with Google is not available yet.',
  account_disabled: 'This account is disabled. Contact the administrator.',
  google_error: 'Google sign-in failed. Please try again.',
};

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

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
  const [google, setGoogle] = useState(false);
  const [params] = useSearchParams();
  const googleError = params.get('login_error');

  useEffect(() => {
    api.get<{ google: boolean }>('/auth/providers').then((r) => setGoogle(r.google)).catch(() => setGoogle(false));
  }, []);

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
          {googleError && <div className="alert error" role="alert"><span>{GOOGLE_ERRORS[googleError] ?? GOOGLE_ERRORS.google_error}</span></div>}
          {google && (
            <>
              <a className="google-button" href="/platform/v1/auth/google/start">
                <GoogleLogo />{mode === 'login' ? 'Continue with Google' : 'Sign up with Google'}
              </a>
              <div className="divider"><span>or with email</span></div>
            </>
          )}
          <label>Email<input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!google} /></label>
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
