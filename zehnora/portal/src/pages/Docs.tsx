import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { CopyButton } from '../components/Markdown';
import { PageHead } from '../components/ui';

type Sample = 'curl' | 'python' | 'langchain';

const ERRORS: [string, string][] = [
  ['401', 'Invalid, revoked or expired key'],
  ['402', 'Not enough credits (checked before the model runs)'],
  ['403', 'Account disabled or model not allowed for this key'],
  ['429', 'Model at capacity; retry after a moment'],
  ['503', 'Model or billing service unavailable'],
];

export default function Docs() {
  const { me } = useSession();
  const [sample, setSample] = useState<Sample>('python');
  const base = me?.api_base_url ?? 'https://api.<OWNER_DOMAIN>/v1';
  const env = `export ZEHNORA_BASE_URL="${base}"\nexport ZEHNORA_API_KEY="<your key from the API keys page>"`;
  const samples: Record<Sample, { label: string; code: string }> = {
    curl: {
      label: 'curl',
      code: `curl $ZEHNORA_BASE_URL/chat/completions \\
  -H "Authorization: Bearer $ZEHNORA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "zehnora-coder", "messages": [{"role": "user", "content": "Say hello"}]}'`,
    },
    python: {
      label: 'OpenAI Python SDK',
      code: `import os
from openai import OpenAI

client = OpenAI(base_url=os.environ["ZEHNORA_BASE_URL"], api_key=os.environ["ZEHNORA_API_KEY"])
reply = client.chat.completions.create(
    model="zehnora-coder",
    messages=[{"role": "user", "content": "Write a Python function that validates a non-empty task title."}],
)
print(reply.choices[0].message.content)`,
    },
    langchain: {
      label: 'LangChain',
      code: `import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="zehnora-coder",
    base_url=os.environ["ZEHNORA_BASE_URL"],
    api_key=os.environ["ZEHNORA_API_KEY"],
    use_responses_api=False,
)
print(llm.invoke("Write a Python function that validates a non-empty task title.").content)`,
    },
  };

  return (
    <>
      <PageHead title="Quickstart" subtitle="Call the Maitre model from your own code in three steps." />
      <div className="steps">
        <section className="card">
          <h2 className="step-title">Create an API key</h2>
          <p className="small muted" style={{ margin: 0 }}>Open <Link to="/keys">API keys</Link>, create a key and copy it. It is shown only once.</p>
        </section>
        <section className="card">
          <h2 className="step-title">Set the base URL and key</h2>
          <div className="copy-row" style={{ marginBottom: 12 }}>
            <code className="secret-value">{base}</code>
            <CopyButton text={base} />
          </div>
          <div className="code-wrap"><pre>{env}</pre><span className="copy-float"><CopyButton text={env} /></span></div>
          <p className="muted small" style={{ margin: '12px 0 0' }}>Use the URL as <code>base_url</code> without adding <code>/chat/completions</code>. Requests run on our own model and GPU through the standard OpenAI format; they are not sent to OpenAI.</p>
        </section>
        <section className="card">
          <h2 className="step-title">Send a request</h2>
          <div className="tabs" role="tablist">
            {(Object.keys(samples) as Sample[]).map((key) => (
              <button key={key} type="button" role="tab" aria-selected={sample === key} className={sample === key ? 'on' : ''} onClick={() => setSample(key)}>{samples[key].label}</button>
            ))}
          </div>
          <div className="code-wrap"><pre>{samples[sample].code}</pre><span className="copy-float"><CopyButton text={samples[sample].code} /></span></div>
          <p className="muted small" style={{ margin: '12px 0 0' }}>Supported: <code>/v1/models</code> and <code>/v1/chat/completions</code> (text, streaming, tool calls). Not yet: <code>/v1/responses</code>, embeddings, images.</p>
        </section>
      </div>
      <section className="card flush" style={{ marginTop: 18 }}>
        <div className="card-head"><h2>Error codes</h2></div>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>{ERRORS.map(([code, text]) => <tr key={code}><td><code>{code}</code></td><td>{text}</td></tr>)}</tbody>
        </table>
      </section>
    </>
  );
}
