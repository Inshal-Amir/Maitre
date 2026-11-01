import { useMemo } from 'react';
import type { ReactElement } from 'react';
import type { ConnectorStatus, ToolInfo } from '../../../shared/types';
import { ErrorNote, Toggle, useAction, useLive } from './shared';
import { Icon } from '../Icon';
import { api } from '../../state';

const MODE_LABEL = (modes: ToolInfo['modes']): string => (modes.includes('chat') ? 'Chat and Work' : 'Work');

function ToolRow({ tool }: { tool: ToolInfo }): ReactElement {
  const { error, run } = useAction();
  return (
    <div className={`item compact ${tool.enabled ? '' : 'off'}`}>
      <div className="item-head">
        <div className="item-main static">
          <span className="item-text">
            <span className="item-title"><code>{tool.name}</code><span className="tag">{MODE_LABEL(tool.modes)}</span>{tool.locked && <span className="tag" title="The Work workflow needs it"><Icon name="lock" size={11} /> always on</span>}</span>
            <span className="item-sub clamp">{tool.description}</span>
          </span>
        </div>
        <Toggle checked={tool.enabled} disabled={tool.locked} label={`${tool.enabled ? 'Turn off' : 'Turn on'} ${tool.name}`} onChange={(enabled) => run('toggle', () => api().setToolEnabled(tool.name, enabled))} />
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

export function ToolsTab({ statuses }: { statuses: ConnectorStatus[] }): ReactElement {
  const [tools] = useLive(() => api().listTools(), ['tools'], [] as ToolInfo[]);
  const groups = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const tool of tools) map.set(tool.group, [...(map.get(tool.group) ?? []), tool]);
    return [...map.entries()];
  }, [tools]);
  const connected = statuses.filter((status) => status.state === 'connected' && status.tools.length);
  return (
    <div className="tab-body">
      <div className="tab-intro">
        <p>Everything the agent can do. Turn off a tool and Maitre will not see or use it. Risky actions still ask you first (Settings → approval policy).</p>
      </div>
      {groups.map(([group, list]) => (
        <section key={group} className="group">
          <div className="group-head"><h4>{group}</h4><span>{list.filter((tool) => tool.enabled).length} of {list.length} on</span></div>
          {list.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
        </section>
      ))}
      <section className="group">
        <div className="group-head"><h4>From connectors</h4><span>Managed in Connectors</span></div>
        {connected.length ? connected.map((status) => (
          <div key={status.id} className="item compact">
            <div className="item-head"><div className="item-main static"><span className="item-text">
              <span className="item-title">{status.name}<span className="tag">{status.tools.length} tools</span></span>
              <span className="tool-chips">{status.tools.map((tool) => <code key={tool}>{tool}</code>)}</span>
            </span></div></div>
          </div>
        )) : <div className="empty-note">No connector tools yet.</div>}
      </section>
    </div>
  );
}
