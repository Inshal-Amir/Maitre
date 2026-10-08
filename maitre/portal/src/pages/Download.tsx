import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Apple, Briefcase, Check, Download as DownloadIcon, FileText, Monitor, Plug, ShieldCheck } from 'lucide-react';
import brand from '@brand/brand.json';
import Markdown from '../components/Markdown';
import { ThemeSwitch } from '../components/ui';

interface DownloadFile { id: 'windows' | 'mac-arm64' | 'mac-x64'; os: string; label: string; file: string; size: number; sha256: string; url: string }
interface Manifest { version: string; released: string; notes: string; page: string; files: DownloadFile[] }

type Platform = 'windows' | 'mac-arm64' | 'mac-x64' | 'mac' | 'other';

interface UAData { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> }

/** Best guess of the visitor's platform. Chrome reports the CPU through client hints; Safari and Firefox only through the GPU name. */
async function detectPlatform(): Promise<Platform> {
  const nav = navigator as Navigator & { userAgentData?: UAData };
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (!/Macintosh|Mac OS X/i.test(ua) || 'ontouchend' in document) return 'other';
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues?.(['architecture']);
    if (hints?.architecture) return hints.architecture.startsWith('arm') ? 'mac-arm64' : 'mac-x64';
  } catch {
    /* hints not available */
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    if (/Apple M\d/i.test(renderer)) return 'mac-arm64';
    if (/Intel|AMD|Radeon/i.test(renderer)) return 'mac-x64';
  } catch {
    /* WebGL blocked */
  }
  return 'mac';
}

const mb = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`;
const ICON = { windows: Monitor, 'mac-arm64': Apple, 'mac-x64': Apple } as const;
const SHORT = { windows: 'Windows', 'mac-arm64': 'Mac (Apple silicon)', 'mac-x64': 'Mac (Intel)' } as const;

const FEATURES = [
  { icon: Briefcase, title: 'Work mode', text: 'Maitre works on your computer: it plans with you, then builds projects, runs commands, uses git, GitHub and Docker, and checks its own work.' },
  { icon: ShieldCheck, title: 'You stay in control', text: 'Reading and safe steps run on their own; deleting, pushing, installing system software or touching secrets always asks you first.' },
  { icon: FileText, title: 'Files and memory', text: 'Attach PDFs, Word and code files. Maitre remembers what you ask it to and keeps long chats focused.' },
  { icon: Plug, title: 'Connected apps', text: 'Connect Google (Gmail, Calendar, Drive, Docs, Sheets) or any MCP server and ask Maitre to use them.' },
];

const STEPS: Record<'windows' | 'mac', { title: string; text: string }[]> = {
  windows: [
    { title: 'Run the installer', text: 'Open Maitre-Setup.exe. If Windows shows “Windows protected your PC”, click More info → Run anyway (the app is not code-signed yet).' },
    { title: 'Create your account', text: 'Open Maitre and choose Create account, or sign in with your console account. The app connects to our model by itself.' },
    { title: 'Ask or let it work', text: 'Use Chat for questions and research, Work for tasks on your computer.' },
  ],
  mac: [
    { title: 'Install', text: 'Open the .dmg and drag Maitre into Applications.' },
    { title: 'Open it the first time', text: 'Right-click Maitre in Applications → Open → Open (it is not notarized yet). If macOS says it is damaged, run xattr -cr /Applications/Maitre.app in Terminal once.' },
    { title: 'Create your account', text: 'Choose Create account or sign in with your console account, then use Chat or Work.' },
  ],
};

export default function Download() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState(false);
  const [platform, setPlatform] = useState<Platform>('other');

  useEffect(() => {
    fetch('/downloads.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject())).then(setManifest).catch(() => setError(true));
    detectPlatform().then(setPlatform);
  }, []);

  const files = manifest?.files ?? [];
  const primary = files.find((f) => f.id === platform) ?? (platform === 'mac' ? files.find((f) => f.id === 'mac-arm64') : undefined);
  const others = files.filter((f) => f !== primary);
  const steps = STEPS[platform === 'windows' ? 'windows' : platform === 'other' ? 'windows' : 'mac'];

  return (
    <div className="download-page">
      <header className="download-top">
        <Link to="/" className="logo"><span className="mark">{brand.productName[0]}</span>{brand.productName}</Link>
        <div className="download-top-actions"><ThemeSwitch /><Link to="/" className="button-link">Console</Link></div>
      </header>

      <section className="download-hero">
        <span className="eyebrow">Maitre Desktop {manifest ? `· ${manifest.version}` : ''}</span>
        <h1>Maitre on your computer</h1>
        <p>Chat, research and real work on your files and projects — with our own AI model, on Windows and Mac.</p>
        {error && <div className="alert error"><span>The download list could not be loaded. Please try again later.</span></div>}
        <div className="download-cta">
          {primary ? (
            <a className="download-button" href={primary.url}>
              <DownloadIcon size={18} />Download for {SHORT[primary.id]}
            </a>
          ) : (
            <span className="muted">{manifest ? 'Choose your system below.' : 'Loading downloads…'}</span>
          )}
          {primary && <span className="download-meta">{primary.label} · {mb(primary.size)} · version {manifest?.version}</span>}
          {platform === 'mac' && primary && <span className="download-meta">Not sure which Mac? Apple menu → About This Mac: “Chip: Apple M…” = Apple silicon, “Processor: Intel” = Intel.</span>}
        </div>
        <img className="download-shot" src="/desktop-preview.png" alt="Maitre Desktop asking questions before it builds a website" />
      </section>

      <section className="download-section">
        <h2>All downloads</h2>
        <div className="download-grid">
          {[...(primary ? [primary] : []), ...others].map((f) => {
            const Icon = ICON[f.id];
            return (
              <a key={f.id} className={`download-card ${f === primary ? 'recommended' : ''}`} href={f.url}>
                <span className="dl-icon"><Icon size={20} /></span>
                <span className="dl-text"><b>{SHORT[f.id]}</b><span>{f.label}</span><small>{f.file} · {mb(f.size)}</small></span>
                {f === primary ? <span className="badge ok">For this computer</span> : <DownloadIcon size={16} className="muted" />}
              </a>
            );
          })}
        </div>
        {manifest && <p className="muted tiny" style={{ marginTop: 10 }}>SHA-256 checksums and older versions: <a href={manifest.page} target="_blank" rel="noreferrer">release page on GitHub</a>.</p>}
      </section>

      <section className="download-section">
        <h2>What it can do</h2>
        <div className="feature-grid">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="feature"><span className="stat-icon"><Icon size={16} /></span><b>{title}</b><p>{text}</p></div>
          ))}
        </div>
      </section>

      <section className="download-section two-col">
        <div>
          <h2>Install in three steps</h2>
          <ol className="install-steps">
            {steps.map((step) => <li key={step.title}><b>{step.title}</b><span>{step.text}</span></li>)}
          </ol>
        </div>
        <div>
          <h2>Requirements</h2>
          <ul className="requirements">
            <li><Check size={15} />Windows 10 or 11 (64-bit), or macOS 12 or newer</li>
            <li><Check size={15} />4 GB RAM and about 500 MB of free disk space</li>
            <li><Check size={15} />An internet connection (the model runs on our GPU server)</li>
            <li><Check size={15} />A Maitre account with credits — <Link to="/register">create one</Link></li>
          </ul>
        </div>
      </section>

      {manifest?.notes && (
        <section className="download-section">
          <h2>What’s new in {manifest.version}</h2>
          <div className="card"><Markdown text={manifest.notes} /></div>
        </section>
      )}

      <footer className="download-foot">{brand.productName} · <Link to="/">Console</Link> · <Link to="/docs">API quickstart</Link></footer>
    </div>
  );
}
