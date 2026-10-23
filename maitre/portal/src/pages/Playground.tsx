import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowUp, Brain, ChevronRight, ImagePlus, SquarePen, Square, Trash2, X } from 'lucide-react';
import { api, streamPost } from '../api';
import { ErrorNote, useSession } from '../App';
import Markdown, { CopyButton } from '../components/Markdown';
import brand from '@brand/brand.json';

interface Conv { id: string; title: string; model: string; updated_at: string }
interface Msg { id: string; role: string; content: string; reasoning?: string; streaming?: boolean; images?: string[] }
interface Picked { id: string; name: string; url: string }

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});

const SUGGESTIONS = [
  'Write a Python function that validates an email address, with tests',
  'Explain the difference between a process and a thread',
  'Review this SQL for performance: SELECT * FROM orders WHERE YEAR(created_at) = 2026',
  'Write a Dockerfile for a FastAPI app with a non-root user',
];

/** Models that think inline wrap reasoning in <think>…</think>; show it apart from the answer. */
function splitThinking(text: string): { reasoning: string; answer: string } {
  const open = text.indexOf('<think>');
  if (open === -1) return { reasoning: '', answer: text };
  const close = text.indexOf('</think>', open);
  if (close === -1) return { reasoning: text.slice(open + 7), answer: text.slice(0, open) };
  return { reasoning: text.slice(open + 7, close), answer: text.slice(0, open) + text.slice(close + 8) };
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 260 ? `…${text.slice(-260)}` : text;
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button type="button" className="ghost thinking-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain size={14} /><span className={active ? 'shimmer' : ''}>{active ? 'Thinking…' : 'Thought process'}</span><ChevronRight size={14} className="chev" />
      </button>
      {open ? <div className="thinking-body">{text.trim()}</div> : active && <div className="thinking-live">{preview.trim()}</div>}
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  if (m.role === 'user') return (
    <div className="msg user">
      <div className="user-stack">
        {!!m.images?.length && <div className="msg-images">{m.images.map((url, i) => <img key={i} src={url} alt={`Attached image ${i + 1}`} />)}</div>}
        {m.content && <div className="bubble">{m.content}</div>}
      </div>
    </div>
  );
  const inline = splitThinking(m.content);
  const reasoning = (m.reasoning ?? '') + inline.reasoning;
  const answer = inline.answer.trim();
  const thinking = !!m.streaming && !answer;
  return (
    <div className="msg assistant">
      <span className="mark" aria-hidden="true" />
      <div className="body">
        {reasoning && <Thinking text={reasoning} active={thinking} />}
        {answer ? <Markdown text={answer} streaming={m.streaming} /> : m.streaming && !reasoning && <div className="dots"><span /><span /><span /></div>}
        {answer && !m.streaming && <div className="msg-actions"><CopyButton text={answer} /></div>}
      </div>
    </div>
  );
}

export default function Playground() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [images, setImages] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const createdHere = useRef<string | null>(null);

  const loadList = async () => setConvs((await api.get<{ conversations: Conv[] }>('/playground/conversations')).conversations);
  const loadConv = async (cid: string) => setMessages((await api.get<{ messages: Msg[] }>(`/playground/conversations/${cid}`)).messages);

  useEffect(() => { loadList().catch(setError); }, []);
  useEffect(() => {
    setError(null);
    if (id && id === createdHere.current) return;
    if (id) loadConv(id).catch(setError); else setMessages([]);
  }, [id]);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => () => abort.current?.abort(), []);

  const patchLast = (fn: (m: Msg) => Msg) => setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));

  const addImages = async (files: File[]) => {
    const wanted = files.filter((f) => f.type.startsWith('image/'));
    if (!wanted.length) return;
    const unsupported = wanted.find((f) => !IMAGE_TYPES.includes(f.type));
    const tooBig = wanted.find((f) => f.size > MAX_IMAGE_BYTES);
    const room = MAX_IMAGES - images.length;
    if (unsupported) setError(new Error(`${unsupported.name}: only PNG, JPEG, WebP and GIF images are supported.`));
    else if (tooBig) setError(new Error(`${tooBig.name} is larger than 8 MB.`));
    else if (wanted.length > room) setError(new Error(`You can attach up to ${MAX_IMAGES} images per message.`));
    const ok = wanted.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES).slice(0, Math.max(0, room));
    try {
      const picked = await Promise.all(ok.map(async (f, i) => ({ id: `${Date.now()}-${i}-${f.name}`, name: f.name, url: await readDataUrl(f) })));
      setImages((cur) => [...cur, ...picked].slice(0, MAX_IMAGES));
    } catch (err) { setError(err); }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.some((f) => f.type.startsWith('image/'))) return;
    e.preventDefault();
    addImages(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    addImages(Array.from(e.dataTransfer.files));
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  const send = async (content: string) => {
    const attached = images.map((img) => img.url);
    if ((!content.trim() && !attached.length) || busy) return;
    stick.current = true;
    setBusy(true);
    setError(null);
    setText('');
    setImages([]);
    const controller = new AbortController();
    abort.current = controller;
    let cid = id;
    setMessages((ms) => [...ms, { id: `u-${Date.now()}`, role: 'user', content, ...(attached.length ? { images: attached } : {}) },
      { id: `a-${Date.now()}`, role: 'assistant', content: '', reasoning: '', streaming: true }]);
    try {
      if (!cid) {
        cid = (await api.post<{ id: string }>('/playground/conversations', {})).id;
        createdHere.current = cid;
        navigate(`/playground/${cid}`, { replace: true });
      }
      await streamPost(`/playground/conversations/${cid}/messages`, { content, images: attached, stream: true }, (d) =>
        patchLast((m) => ({ ...m, content: m.content + (d.content ?? ''), reasoning: (m.reasoning ?? '') + (d.reasoning ?? '') })), controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setError(err);
    } finally {
      patchLast((m) => (m.role === 'assistant' ? { ...m, streaming: false } : m));
      setMessages((ms) => ms.map((m, i) => (i === ms.length - 1 && m.role === 'assistant' && !m.content && !m.reasoning
        ? { ...m, content: controller.signal.aborted ? '_Stopped._' : '_(No answer was received.)_' } : m)));
      abort.current = null;
      setBusy(false);
      loadList().catch(() => {});
      refresh().catch(() => {});
      input.current?.focus();
    }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); send(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
  };

  const remove = async (cid: string) => {
    if (!window.confirm('Delete this conversation permanently?')) return;
    try {
      await api.del(`/playground/conversations/${cid}`);
      if (cid === id) navigate('/playground');
      await loadList();
    } catch (err) { setError(err); }
  };

  const empty = messages.length === 0;
  return (
    <div className="playground">
      <aside className="conv-pane">
        <button className="ghost new-chat" onClick={() => navigate('/playground')}><SquarePen size={16} />New chat</button>
        <div className="conv-heading">History</div>
        <div className="conv-scroll">
          {convs.map((c) => (
            <div key={c.id} className={`conv ${c.id === id ? 'active' : ''}`}>
              <button className="conv-title" onClick={() => navigate(`/playground/${c.id}`)} title={c.title}>{c.title}</button>
              <button className="ghost icon conv-del" onClick={() => remove(c.id)} aria-label="Delete conversation"><Trash2 size={14} /></button>
            </div>
          ))}
          {convs.length === 0 && <p className="muted small pad">No conversations yet.</p>}
        </div>
      </aside>

      <section className="chat">
        <div className="chat-top">
          <span className="model-pill"><span className="live" />maitre-coder</span>
          <span className="muted tiny">Each message uses credits from your account</span>
        </div>
        <div className="messages" ref={scroller}>
          {empty ? (
            <div className="empty">
              <span className="mark" aria-hidden="true" />
              <h2>What are we building today?</h2>
              <p>Try the model before you use it from your own code.</p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => send(s)} disabled={busy}>{s}</button>)}
              </div>
            </div>
          ) : (
            <div className="thread">{messages.map((m) => <Message key={m.id} m={m} />)}</div>
          )}
        </div>
        <div className={`composer-wrap ${dragging ? 'dragging' : ''}`} onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <ErrorNote error={error} />
          {images.length > 0 && (
            <div className="attachments" aria-label="Attached images">
              {images.map((img) => (
                <div key={img.id} className="attachment">
                  <img src={img.url} alt={img.name} title={img.name} />
                  <button type="button" className="attachment-remove" onClick={() => setImages((cur) => cur.filter((c) => c.id !== img.id))}
                          aria-label={`Remove ${img.name}`}><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <form className="composer" onSubmit={submit}>
            <input ref={filePicker} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden
                   onChange={(e) => { addImages(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            <button type="button" className="ghost icon attach" onClick={() => filePicker.current?.click()}
                    disabled={busy || images.length >= MAX_IMAGES} aria-label="Attach images" title="Attach images (PNG, JPEG, WebP, GIF; up to 4, 8 MB each)">
              <ImagePlus size={18} />
            </button>
            <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
                      placeholder="Message maitre-coder" rows={1} aria-label="Message" autoFocus />
            {busy
              ? <button type="button" className="send stop" onClick={() => abort.current?.abort()} aria-label="Stop generating"><Square size={14} fill="currentColor" /></button>
              : <button className="send" disabled={!text.trim() && !images.length} aria-label="Send"><ArrowUp size={18} /></button>}
          </form>
          <p className="muted tiny center-text">Runs on our own GPU. Each message uses credits. Answers can be wrong; check important code.</p>
        </div>
      </section>
    </div>
  );
}
