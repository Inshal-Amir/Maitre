import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, credits, type User, type WalletView } from '../api';
import { ErrorNote } from '../App';
import { Ago, PageHead } from '../components/ui';

type Row = User & { wallet: WalletView };

export default function AdminUsers() {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<Row[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = async (query = q) => {
    try { setUsers((await api.get<{ users: Row[] }>(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`)).users); }
    catch (e) { setError(e); }
  };
  useEffect(() => { load(''); }, []);
  return (
    <>
      <PageHead title="Users &amp; credits" subtitle="Find an account to grant credits, adjust balances or disable access." />
      <ErrorNote error={error} />
      <form className="card row" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input className="grow" placeholder="Search by email" value={q} onChange={(e) => setQ(e.target.value)} />
        <button>Search</button>
      </form>
      <section className="card flush">
        <div className="card-head"><h2>Accounts</h2><span className="hint">{users.length} shown</span></div>
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Available</th><th>Reserved</th><th>Joined</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><Link to={`/admin/users/${u.id}`}>{u.email}</Link></td><td>{u.role}</td>
                <td><span className={`badge ${u.status}`}>{u.status}</span></td>
                <td>{credits(u.wallet.available_units)}</td><td>{credits(u.wallet.reserved_units)}</td><td className="nowrap"><Ago iso={u.created_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
