import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, Hourglass, RefreshCw, Wallet } from 'lucide-react';
import brand from '@brand/brand.json';
import { api, credits, type LedgerEntry, type UsageRow, type WalletView } from '../api';
import { ErrorNote } from '../App';
import { Ago, PageHead, Stat, compact, useShowMore } from '../components/ui';

interface UsageResp { totals: { requests: number; input_tokens: number; output_tokens: number; charged_units: number; errors: number }; requests: UsageRow[] }

const DAYS = 14;

/** Credits charged per day over the last two weeks, from the most recent requests the API returns. */
function daily(rows: UsageRow[], per: number): { start: number; label: string; value: number; requests: number }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(today);
    day.setDate(today.getDate() - (DAYS - 1 - i));
    return { start: day.getTime(), label: day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: 0, requests: 0 };
  });
  for (const row of rows) {
    const day = new Date(row.created_at);
    day.setHours(0, 0, 0, 0);
    const bucket = buckets[Math.round((day.getTime() - buckets[0].start) / 86_400_000)];
    if (!bucket) continue;
    bucket.value += (row.charged_units ?? 0) / per;
    bucket.requests += 1;
  }
  return buckets;
}

export default function Dashboard() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [usage, setUsage] = useState<UsageResp | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const w = await api.get<{ wallet: WalletView; ledger: LedgerEntry[] }>('/wallet');
      setWallet(w.wallet);
      setLedger(w.ledger);
      setUsage(await api.get<UsageResp>('/usage'));
      setError(null);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const per = wallet?.units_per_credit ?? 1000;
  const days = useMemo(() => daily(usage?.requests ?? [], per), [usage, per]);
  const peak = Math.max(...days.map((d) => d.value), 0.0001);
  const requests = useShowMore(usage?.requests ?? []);
  const history = useShowMore(ledger);
  const totals = usage?.totals;

  return (
    <>
      <PageHead title="Overview" subtitle="Your credits, usage and recent requests.">
        <button onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} />Refresh</button>
      </PageHead>
      <ErrorNote error={error} />
      {wallet && wallet.available_units === 0 && (
        <div className="alert info">You have no credits yet. Ask the administrator to grant demo credits, then <Link to="/keys">create an API key</Link>.</div>
      )}
      <section className="stats">
        <Stat icon={Wallet} tone="ok" label="Available credits" value={wallet ? credits(wallet.available_units, per) : '—'} sub={`1 credit = ${per.toLocaleString()} units`} />
        <Stat icon={Hourglass} tone="warn" label="Reserved now" value={wallet ? credits(wallet.reserved_units, per) : '—'} sub="Held for requests in progress" />
        <Stat icon={Activity} tone="info" label="Requests" value={totals ? totals.requests.toLocaleString() : '—'}
              sub={totals ? `${compact(totals.input_tokens)} in · ${compact(totals.output_tokens)} out tokens` : ''} />
        <Stat icon={AlertTriangle} label="Errors" value={totals ? totals.errors.toLocaleString() : '—'} sub={totals && totals.requests ? `${((totals.errors / totals.requests) * 100).toFixed(1)}% of requests` : ''} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Credits used per day</h2><span className="hint">Last {DAYS} days · from your latest {usage?.requests.length ?? 0} requests</span></div>
        <div className="chart" role="img" aria-label="Credits used per day">
          {days.map((d) => (
            <div key={d.start} className="bar-col" title={`${d.label}: ${d.value.toFixed(2)} credits, ${d.requests} requests`}>
              <div className={`bar ${d.value ? '' : 'zero'}`} style={{ height: `${Math.max(2, (d.value / peak) * 100)}%` }} />
              <span className="bar-label">{new Date(d.start).getDate()}</span>
            </div>
          ))}
        </div>
        <div className="legend">
          <div><b>{days.reduce((s, d) => s + d.value, 0).toFixed(2)}</b>credits in {DAYS} days</div>
          <div><b>{days.reduce((s, d) => s + d.requests, 0)}</b>requests in {DAYS} days</div>
          <div><b>{totals ? credits(totals.charged_units, per) : '—'}</b>credits charged in total</div>
        </div>
      </section>

      <section className="card flush">
        <div className="card-head"><h2>Recent requests</h2><span className="hint">{brand.creditsNotice}</span></div>
        <table>
          <thead><tr><th>When</th><th>Model</th><th>Source</th><th>State</th><th>Tokens in / out</th><th>Charged</th><th>Error</th></tr></thead>
          <tbody>
            {requests.visible.map((r) => (
              <tr key={r.id}>
                <td className="nowrap"><Ago iso={r.created_at} /></td>
                <td><code>{r.model}</code>{r.stream && <span className="muted tiny"> · stream</span>}</td>
                <td className="muted">{r.source}</td>
                <td><span className={`badge ${r.state}`}>{r.state.replace(/_/g, ' ')}</span></td>
                <td>{r.input_tokens?.toLocaleString() ?? '—'} / {r.output_tokens?.toLocaleString() ?? '—'}</td>
                <td>{r.charged_units == null ? '—' : credits(r.charged_units, per)}</td>
                <td className="small danger-text">{r.error_code ?? ''}</td>
              </tr>
            ))}
            {usage && usage.requests.length === 0 && <tr><td colSpan={7} className="empty-row">No requests yet. Try the <Link to="/playground">playground</Link> or the <Link to="/docs">quickstart</Link>.</td></tr>}
          </tbody>
        </table>
        {requests.more}
      </section>

      <section className="card flush">
        <div className="card-head"><h2>Credit history</h2><span className="hint">Every grant and charge, permanent</span></div>
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reason</th></tr></thead>
          <tbody>
            {history.visible.map((e) => (
              <tr key={e.id}>
                <td className="nowrap"><Ago iso={e.created_at} /></td>
                <td><span className={`badge plain ${e.kind === 'grant' ? 'ok' : ''}`}>{e.kind}</span></td>
                <td className={e.amount_units < 0 ? 'neg' : 'pos'}>{e.amount_units > 0 ? '+' : ''}{credits(e.amount_units, per)}</td>
                <td>{credits(e.balance_after_units, per)}</td>
                <td className="small muted">{e.reason}</td>
              </tr>
            ))}
            {ledger.length === 0 && <tr><td colSpan={5} className="empty-row">No credit activity yet.</td></tr>}
          </tbody>
        </table>
        {history.more}
      </section>
    </>
  );
}
