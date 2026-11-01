import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { InstallResult, MarketplaceInfo, MarketplacePlugin, PluginInfo, PluginPreview } from '../../../shared/types';
import { Empty, ErrorNote, ExternalLink, Toggle, useAction, useLive } from './shared';
import { Icon } from '../Icon';
import { api } from '../../state';

const PAGE = 40;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function Contents({ plugin }: { plugin: Pick<PluginInfo, 'skills' | 'commands' | 'servers' | 'ignored'> }): ReactElement {
  return (
    <div className="contents">
      {plugin.skills.length > 0 && <div><b>Skills</b> {plugin.skills.join(', ')}</div>}
      {plugin.commands.length > 0 && <div><b>Commands</b> {plugin.commands.map((name) => `/${name}`).join(', ')}</div>}
      {plugin.servers.length > 0 && (
        <div>
          <b>Connectors</b>
          <ul>
            {plugin.servers.map((server) => (
              <li key={server.id}><span>{server.name}</span> <code>{server.target}</code>{server.missingVars.length > 0 && <em> needs {server.missingVars.join(', ')}</em>}</li>
            ))}
          </ul>
        </div>
      )}
      {plugin.ignored.length > 0 && <div className="muted">Not used by Maitre: {plugin.ignored.join(', ')}</div>}
    </div>
  );
}

/** The review step: what a plugin brings and what it will run, before anything is installed. */
function Review({ preview, onClose }: { preview: PluginPreview; onClose(installed: boolean): void }): ReactElement {
  const { busy, error, run } = useAction();
  const local = preview.servers.filter((server) => !/^https?:\/\//.test(server.target));
  const cancel = (): void => {
    api().cancelPlugin(preview.stagingId);
    onClose(false);
  };
  return (
    <div className="overlay inner" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <div className="dialog review" role="dialog" aria-label={`Install ${preview.name}`}>
        <div className="dialog-head">
          <h2><Icon name="puzzle" size={18} /> {preview.replaces ? 'Update' : 'Install'} {preview.name}{preview.version ? ` ${preview.version}` : ''}</h2>
          <button type="button" className="icon-btn" onClick={cancel} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <div className="dialog-body">
          {preview.description && <p>{preview.description}</p>}
          <div className="field-note">From {preview.source}{preview.author ? ` · by ${preview.author}` : ''}</div>
          <Contents plugin={preview} />
          {local.length > 0 && (
            <div className="caution" role="note">
              <Icon name="shield" size={15} />
              <span>This plugin starts {plural(local.length, 'program')} on your computer (listed above) when it is turned on. Only install plugins from people you trust.</span>
            </div>
          )}
          <ErrorNote error={error} />
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={cancel}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy !== null} onClick={async () => { if (await run('install', () => api().confirmPlugin(preview.stagingId))) onClose(true); }}>
            {busy ? 'Installing…' : preview.replaces ? 'Update' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}

function InstalledRow({ plugin, onReview }: { plugin: PluginInfo; onReview(preview: PluginPreview): void }): ReactElement {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const summary = [plural(plugin.skills.length, 'skill'), plugin.commands.length ? plural(plugin.commands.length, 'command') : '', plugin.servers.length ? plural(plugin.servers.length, 'connector') : ''].filter(Boolean).join(' · ');
  return (
    <div className={`item ${plugin.enabled ? '' : 'off'}`}>
      <div className="item-head">
        <button type="button" className="item-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="item-icon"><Icon name="puzzle" size={15} /></span>
          <span className="item-text">
            <span className="item-title">{plugin.name}{plugin.version && <span className="tag">{plugin.version}</span>}</span>
            <span className="item-sub">{plugin.description || summary}</span>
          </span>
        </button>
        <Toggle checked={plugin.enabled} label={`${plugin.enabled ? 'Turn off' : 'Turn on'} ${plugin.name}`} onChange={(enabled) => run('toggle', () => api().setPluginEnabled(plugin.id, enabled))} />
      </div>
      {open && (
        <div className="item-body">
          <div className="field-note">{summary} · from {plugin.source}</div>
          <Contents plugin={plugin} />
          <div className="connector-actions">
            <button type="button" className="btn small" disabled={busy !== null} onClick={() => run('update', async () => onReview(await api().updatePlugin(plugin.id)))}>{busy === 'update' ? 'Checking…' : 'Update'}</button>
            <button type="button" className="btn small" onClick={() => api().revealPath(plugin.dir)}>Show in folder</button>
            <button type="button" className="btn small danger" disabled={busy !== null} onClick={() => run('remove', () => api().removePlugin(plugin.id))}>Uninstall</button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function MarketplaceEntry({ market, entry, onReview }: { market: MarketplaceInfo; entry: MarketplacePlugin; onReview(preview: PluginPreview): void }): ReactElement {
  const { busy, error, run } = useAction();
  return (
    <div className="market-row">
      <div className="item-text">
        <span className="item-title">{entry.name}{entry.category && <span className="tag">{entry.category}</span>}</span>
        <span className="item-sub clamp">{entry.description}</span>
        <ErrorNote error={error} />
      </div>
      {entry.installed ? <span className="field-note ok"><Icon name="check" size={14} /> Installed</span> : (
        <button type="button" className="btn small" disabled={busy !== null} onClick={() => run('get', async () => onReview(await api().inspectMarketplacePlugin(market.id, entry.name)))}>
          {busy ? 'Downloading…' : 'Get'}
        </button>
      )}
    </div>
  );
}

function Marketplace({ market, onReview }: { market: MarketplaceInfo; onReview(preview: PluginPreview): void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const { busy, error, run } = useAction();
  const loading = useRef(false);

  useEffect(() => {
    if (!open || market.loaded || loading.current) return;
    loading.current = true;
    run('load', () => api().refreshMarketplace(market.id)).finally(() => { loading.current = false; });
  }, [open, market.loaded, market.id, run]);

  const categories = useMemo(() => [...new Set(market.plugins.map((entry) => entry.category).filter((value): value is string => Boolean(value)))].sort(), [market.plugins]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return market.plugins.filter((entry) => (!category || entry.category === category) && words.every((word) => `${entry.name} ${entry.description}`.toLowerCase().includes(word)));
  }, [market.plugins, query, category]);

  return (
    <div className="item market">
      <div className="item-head">
        <button type="button" className="item-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="item-icon"><Icon name="download" size={15} /></span>
          <span className="item-text">
            <span className="item-title">{market.name}{market.loaded && <span className="tag">{plural(market.plugins.length, 'plugin')}</span>}</span>
            <span className="item-sub">{market.description ?? market.source}</span>
          </span>
        </button>
        <Icon name="chevron" size={14} className={`tool-chevron ${open ? 'open' : ''}`} />
      </div>
      {open && (
        <div className="item-body">
          <div className="filters">
            <input className="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE); }} placeholder={`Search ${market.name}`} aria-label="Search plugins" />
            {categories.length > 1 && (
              <select value={category} onChange={(event) => { setCategory(event.target.value); setLimit(PAGE); }} aria-label="Category">
                <option value="">All categories</option>
                {categories.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            )}
            <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" disabled={busy !== null} onClick={() => run('load', () => api().refreshMarketplace(market.id))}><Icon name="refresh" size={15} /></button>
            <button type="button" className="link" onClick={() => run('remove', () => api().removeMarketplace(market.id))}>Remove</button>
          </div>
          {busy === 'load' && <div className="waiting"><span className="spinner" /> Loading {market.source}…</div>}
          <ErrorNote error={error || market.error || ''} />
          <div className="market-list">
            {shown.slice(0, limit).map((entry) => <MarketplaceEntry key={entry.name} market={market} entry={entry} onReview={onReview} />)}
            {market.loaded && !shown.length && <Empty>No plugins match.</Empty>}
          </div>
          {shown.length > limit && <button type="button" className="btn small" onClick={() => setLimit(limit + PAGE)}>Show more ({shown.length - limit})</button>}
          <div className="field-note">Source: <ExternalLink href={`https://github.com/${market.source}`}>{market.source}</ExternalLink>. Maitre uses a plugin's skills, commands and MCP connectors; hooks and sub-agents are skipped.</div>
        </div>
      )}
    </div>
  );
}

export function PluginsTab(): ReactElement {
  const [plugins, reloadPlugins] = useLive(() => api().listPlugins(), ['plugins'], [] as PluginInfo[]);
  const [markets, reloadMarkets] = useLive(() => api().listMarketplaces(), ['plugins'], [] as MarketplaceInfo[]);
  const [source, setSource] = useState('');
  const [review, setReview] = useState<PluginPreview | null>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();

  const refreshAll = async (): Promise<void> => {
    await Promise.all([reloadPlugins(), reloadMarkets()]);
  };

  const handle = async (result: InstallResult | null): Promise<void> => {
    if (!result) return;
    if (result.kind === 'plugin') setReview(result.preview);
    else if (result.kind === 'marketplace') setNotice(`Added the marketplace "${result.marketplace.name}" with ${plural(result.marketplace.plugins.length, 'plugin')}. Open it below to pick plugins.`);
    else setNotice(`Added ${plural(result.skills.length, 'skill')}: ${result.skills.map((skill) => skill.name).join(', ')}. Find them under Skills.`);
    setSource('');
    await refreshAll();
  };

  const install = (input: string): Promise<boolean> => run('inspect', async () => {
    setNotice('');
    await handle(await api().inspectSource(input));
  });

  return (
    <div className="tab-body">
      <div className="tab-intro">
        <p>Plugins bundle skills, slash commands and connectors. Maitre installs Claude Code plugins and marketplaces, and plain skill repositories.</p>
        <form className="install" onSubmit={(event) => { event.preventDefault(); if (source.trim()) install(source); }}>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="GitHub address: owner/repo or https://github.com/…" aria-label="Plugin or marketplace address" spellCheck={false} />
          <button type="submit" className="btn primary small" disabled={busy !== null || !source.trim()}>{busy ? 'Looking…' : 'Install'}</button>
          <button type="button" className="btn small" disabled={busy !== null} onClick={() => install('')}>From folder…</button>
        </form>
        {notice && <div className="field-note ok">{notice}</div>}
        <ErrorNote error={error} />
      </div>
      <section className="group">
        <div className="group-head"><h4>Installed</h4></div>
        {plugins.length ? plugins.map((plugin) => <InstalledRow key={plugin.id} plugin={plugin} onReview={setReview} />) : <Empty>No plugins yet. Browse a marketplace below or paste a GitHub address above.</Empty>}
      </section>
      <section className="group">
        <div className="group-head"><h4>Marketplaces</h4><span>Add your own by pasting its GitHub address above.</span></div>
        {markets.map((market) => <Marketplace key={market.id} market={market} onReview={setReview} />)}
        {!markets.length && <Empty>No marketplaces.</Empty>}
      </section>
      {review && <Review preview={review} onClose={(installed) => { setReview(null); if (installed) setNotice(`${review.name} is installed and on.`); refreshAll(); }} />}
    </div>
  );
}
