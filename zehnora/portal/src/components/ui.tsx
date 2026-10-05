import { useEffect, useState, type ReactNode } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';

export function PageHead({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="titles">
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}

export function Stat({ icon: Icon, label, value, sub, tone }: { icon: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'info' }) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className="label">{label}</span>
        <span className={`stat-icon ${tone ?? ''}`}><Icon size={16} strokeWidth={2} /></span>
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** First `size` rows, with a button that reveals the rest. */
export function useShowMore<T>(rows: T[], size = 10): { visible: T[]; more: ReactNode } {
  const [all, setAll] = useState(false);
  const visible = all ? rows : rows.slice(0, size);
  const more = rows.length > size ? (
    <div className="card-foot">
      <button className="ghost small" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${rows.length}`}</button>
    </div>
  ) : null;
  return { visible, more };
}

const UNITS: [number, string][] = [[60, 's'], [60, 'min'], [24, 'h'], [7, 'd']];

/** "5 min ago" for recent times, a short date after a week; full time in the title attribute. */
export function Ago({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="muted">—</span>;
  const date = new Date(iso);
  let delta = Math.max(0, (Date.now() - date.getTime()) / 1000);
  let label = '';
  for (const [size, unit] of UNITS) {
    if (delta < size) {
      label = unit === 's' ? 'just now' : `${Math.floor(delta)} ${unit} ago`;
      break;
    }
    delta /= size;
  }
  if (!label) label = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return <time dateTime={iso} title={date.toLocaleString()}>{label}</time>;
}

export const compact = (value: number): string => new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'zehnora.theme';

export function applyStoredTheme(): void {
  let theme: Theme = 'system';
  try {
    theme = (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system';
  } catch {
    /* storage can be unavailable */
  }
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage can be unavailable */
    }
    applyStoredTheme();
  }, [theme]);
  const options: [Theme, LucideIcon, string][] = [['light', Sun, 'Light'], ['system', Monitor, 'System'], ['dark', Moon, 'Dark']];
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {options.map(([value, Icon, label]) => (
        <button key={value} type="button" role="radio" aria-checked={theme === value} className={theme === value ? 'on' : ''} onClick={() => setTheme(value)} title={label}>
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
