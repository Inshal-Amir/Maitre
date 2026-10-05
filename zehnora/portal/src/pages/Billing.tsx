import { Link } from 'react-router-dom';
import { Coins, CreditCard, Gift, History } from 'lucide-react';
import { useSession } from '../App';
import { PageHead, Stat } from '../components/ui';

/** Credit packages shown before online payment is connected; amounts only, prices are set when payments launch. */
const PACKAGES = [
  { credits: 1_000, label: 'Starter', note: 'Try the API and the playground' },
  { credits: 5_000, label: 'Builder', note: 'Daily use for one developer', popular: true },
  { credits: 20_000, label: 'Team', note: 'Several people or heavy agent work' },
];

export default function Billing() {
  const { me } = useSession();
  const available = me?.wallet.available_credits ?? 0;
  const reserved = me?.wallet.reserved_credits ?? 0;
  return (
    <>
      <PageHead title="Billing" subtitle="Your credit balance and how to get more credits." />
      <section className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <Stat icon={Coins} tone="ok" label="Available credits" value={available.toLocaleString(undefined, { maximumFractionDigits: 2 })} sub="Usable now" />
        <Stat icon={History} tone="warn" label="Reserved" value={reserved.toLocaleString(undefined, { maximumFractionDigits: 2 })} sub="Held for requests in progress" />
        <Stat icon={CreditCard} tone="info" label="Payment method" value="—" sub="Online payment is coming soon" />
      </section>

      <section className="card">
        <div className="card-head"><h2>Buy credits</h2><span className="badge warn">Coming soon</span></div>
        <div className="packages">
          {PACKAGES.map((pack) => (
            <div key={pack.label} className={`package ${pack.popular ? 'popular' : ''}`}>
              {pack.popular && <span className="tag">Popular</span>}
              <span className="muted small">{pack.label}</span>
              <span className="amount">{pack.credits.toLocaleString()} credits</span>
              <span className="per">{pack.note}</span>
              <button className={pack.popular ? 'primary' : ''} disabled title="Online payment is not connected yet">Buy — coming soon</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2><Gift size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />Get credits today</h2></div>
        <p className="small" style={{ margin: 0 }}>Until online payment is available, the administrator adds credits to your account. Send the email you signed in with
          {me ? <> (<b>{me.user.email}</b>)</> : null} to the Zehnora team. Every grant and charge appears in your <Link to="/">credit history</Link>.</p>
      </section>

      <section className="card">
        <div className="card-head"><h2>How credits are charged</h2></div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>1 credit = 1,000 units. Each input token costs 1 unit and each output token 2 units (see <Link to="/models">Models</Link>).</li>
          <li>Before a request runs, the most it can cost is reserved; afterwards only the real usage is charged and the rest is released.</li>
          <li>Requests that fail before the model answers are not charged.</li>
        </ul>
      </section>
    </>
  );
}
