import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { ConnectorStatus, Settings } from '../../../shared/types';
import type { IconName } from '../Icon';
import { ConnectorsTab } from './Connectors';
import { PluginsTab } from './Plugins';
import { SkillsTab } from './Skills';
import { ToolsTab } from './Tools';
import { Icon } from '../Icon';

export type CustomizeTab = 'skills' | 'connectors' | 'plugins' | 'tools';

const TABS: { id: CustomizeTab; label: string; icon: IconName; hint: string }[] = [
  { id: 'skills', label: 'Skills', icon: 'book', hint: 'How Maitre does tasks' },
  { id: 'connectors', label: 'Connectors', icon: 'plug', hint: 'Apps and MCP servers' },
  { id: 'plugins', label: 'Plugins', icon: 'puzzle', hint: 'Bundles and marketplaces' },
  { id: 'tools', label: 'Tools', icon: 'wrench', hint: 'What the agent may use' },
];

export function Customize({ tab, settings, connectors, cwd, onTab, onClose }: {
  tab: CustomizeTab;
  settings: Settings;
  connectors: ConnectorStatus[];
  /** Working folder of the open Work task, for its project skills. */
  cwd?: string;
  onTab(tab: CustomizeTab): void;
  onClose(): void;
}): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !document.querySelector('.overlay.inner')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog customize" role="dialog" aria-label="Customize Maitre">
        <nav className="customize-nav" aria-label="Customize sections">
          <h2>Customize</h2>
          {TABS.map((entry) => (
            <button key={entry.id} type="button" className={tab === entry.id ? 'on' : ''} aria-current={tab === entry.id ? 'page' : undefined} onClick={() => onTab(entry.id)}>
              <Icon name={entry.icon} size={16} />
              <span>
                <b>{entry.label}</b>
                <small>{entry.hint}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="customize-main">
          <div className="dialog-head">
            <h2>{TABS.find((entry) => entry.id === tab)?.label}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>
          <div className="dialog-body">
            {tab === 'skills' && <SkillsTab cwd={cwd} onBrowse={() => onTab('plugins')} />}
            {tab === 'connectors' && <ConnectorsTab statuses={connectors} servers={settings.mcpServers} google={settings.google} />}
            {tab === 'plugins' && <PluginsTab />}
            {tab === 'tools' && <ToolsTab statuses={connectors} />}
          </div>
        </div>
      </div>
    </div>
  );
}
