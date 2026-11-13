import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, session } from 'electron';
import { documentHtml } from './html';

const PARTITION = 'maitre-pdf';
/** Placed before the page's own CSS: fixed-height pages with padding then fit the sheet instead of spilling onto blank pages. */
const BASE_STYLE = '<style>*, *::before, *::after { box-sizing: border-box; } html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }</style>';

/** The PDF window may load only its own page and data: URLs; nothing goes out to the network. */
function offlineSession(): Electron.Session {
  const pdfSession = session.fromPartition(PARTITION);
  pdfSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/i.test(details.url) }));
  return pdfSession;
}

/** Renders Markdown to a PDF with Chromium's print engine, in a hidden window with scripts off. */
export const markdownPdf = (title: string, markdown: string): Promise<Buffer> => htmlPdf(documentHtml(title, markdown));

/** Renders a complete HTML page (CSS, inline SVG charts and shapes) to a PDF, offline and with scripts off. */
export async function htmlPdf(html: string): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maitre-pdf-'));
  const page = path.join(dir, 'document.html');
  fs.writeFileSync(page, `${/<meta\s+charset/i.test(html) ? '' : '<meta charset="utf-8">'}${BASE_STYLE}${html}`);
  const window = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, offscreen: true, session: offlineSession() } });
  try {
    await window.loadFile(page);
    return await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: true });
  } finally {
    window.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
