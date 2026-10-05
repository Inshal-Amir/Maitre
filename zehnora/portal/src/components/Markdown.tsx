import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { Check, Copy } from 'lucide-react';

const LANGUAGE_NAMES: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', jsx: 'JSX', py: 'Python', python: 'Python',
  bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Shell', ps1: 'PowerShell', powershell: 'PowerShell', sql: 'SQL', json: 'JSON', yaml: 'YAML',
  yml: 'YAML', html: 'HTML', css: 'CSS', go: 'Go', rust: 'Rust', rs: 'Rust', java: 'Java', c: 'C', cpp: 'C++', cs: 'C#', php: 'PHP',
  rb: 'Ruby', ruby: 'Ruby', kotlin: 'Kotlin', swift: 'Swift', dockerfile: 'Dockerfile', docker: 'Dockerfile', md: 'Markdown', markdown: 'Markdown',
  text: 'Text', txt: 'Text', plaintext: 'Text', output: 'Output', console: 'Console', diff: 'Diff', xml: 'XML', toml: 'TOML', ini: 'INI',
};

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className="ghost icon-text" onClick={copy} aria-label={label}>
      {done ? <Check size={14} /> : <Copy size={14} />}<span>{done ? 'Copied' : label}</span>
    </button>
  );
}

/** A fenced code block: language label, copy button and syntax highlighting (plain for text and program output). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child && typeof child === 'object' && 'props' in child ? (child.props as { className?: string }).className : '') ?? '';
  const lang = (className.match(/language-([\w+#-]+)/)?.[1] ?? '').toLowerCase();
  const code = textOf(children).replace(/\n$/, '');
  const plain = !lang || ['text', 'txt', 'plaintext', 'output', 'console'].includes(lang);
  const html = useMemo(() => {
    if (plain) return null;
    try {
      return hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, lang, plain]);
  return (
    <div className={`code-block ${plain ? 'plain' : ''}`}>
      <div className="code-head"><span>{LANGUAGE_NAMES[lang] ?? (lang || 'Text')}</span><CopyButton text={code} /></div>
      {html ? <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre> : <pre><code>{code}</code></pre>}
    </div>
  );
}

/** Markdown answer; `streaming` adds a typing cursor and closes an unfinished code fence so half-written code renders as code. */
function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const source = streaming && (text.match(/^```/gm)?.length ?? 0) % 2 === 1 ? `${text}\n\`\`\`` : text;
  return (
    <div className={`markdown ${streaming ? 'streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        pre: CodeBlock,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
      }}>{source}</ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
