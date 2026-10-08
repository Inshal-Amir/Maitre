import { useEffect, useState, type FormEvent } from 'react';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { api, type KeyView } from '../api';
import { ErrorNote } from '../App';
import { Ago, PageHead } from '../components/ui';

export default function Keys() {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try { setKeys((await api.get<{ keys: KeyView[] }>('/keys')).keys); } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ secret: string }>('/keys', { name, expires_in_days: expires ? Number(expires) : null });
      setSecret(r.secret);
      setCopied(false);
      setName('');
      await load();
    } catch (err) { setError(err); }
  };

  const revoke = async (k: KeyView) => {
    if (!window.confirm(`Revoke "${k.name}"? Requests using it will fail immediately.`)) return;
    try { await api.post(`/keys/${k.id}/revoke`); await load(); } catch (err) { setError(err); }
  };

  return (
    <>
      <PageHead title="API keys" subtitle="Keys let your code call the Maitre API. Each key is shown once; keep it secret." />
      <ErrorNote error={error} />
      {secret && (
        <div className="card secret">
          <div className="card-head"><h2>Your new key</h2></div>
          <p className="small"><strong>Copy it now.</strong> It is shown once and cannot be recovered. Store it in an environment variable, not in source code.</p>
          <div className="copy-row">
            <code className="secret-value">{secret}</code>
            <button className="primary" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }}><Copy size={14} />{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button onClick={() => setSecret(null)}>I have stored it</button></div>
        </div>
      )}
      <form className="card" onSubmit={create}>
        <div className="card-head"><h2>Create a key</h2></div>
        <div className="row wrap">
        <label className="grow">Key name<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop" required /></label>
        <label>Expires
          <select value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="">Never</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
          </select>
        </label>
        <button className="primary"><Plus size={15} />Create key</button>
        </div>
      </form>
      <section className="card flush">
        <div className="card-head"><h2>Your keys</h2><span className="hint">{keys.filter((k) => k.status === 'active').length} active</span></div>
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Models</th><th>Status</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className={k.status === 'revoked' ? 'dim' : ''}>
                <td><b>{k.name}</b></td><td><code>{k.display}</code></td><td>{k.models.join(', ')}</td>
                <td><span className={`badge ${k.status}`}>{k.status}</span></td>
                <td className="nowrap"><Ago iso={k.created_at} /></td><td className="nowrap"><Ago iso={k.last_used_at} /></td><td className="nowrap">{k.expires_at ? <Ago iso={k.expires_at} /> : <span className="muted">Never</span>}</td>
                <td>{k.status === 'active' && <button className="danger small" onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>
            ))}
            {keys.length === 0 && <tr><td colSpan={8} className="empty-row"><KeyRound size={18} /><br />No keys yet. Create one above to call the API.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}
