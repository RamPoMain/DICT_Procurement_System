// ============================================================
// DTMS PROXY (Express, Node 18+)   npm i express multer
//
// The browser talks to /api/dtms/*; this router talks to DTMS. It exists because:
//   1. the DTMS API key must never be in page code, and
//   2. DTMS allows only 30 requests/minute per key, shared by every user — so reads are cached here and
//      any number of open browser tabs cost DTMS about one list call a minute.
//
// Environment:
//   DTMS_BASE     e.g. https://dtms.example.gov.ph/api/v1/        (must end with /)
//   DTMS_API_KEY  the dtms_… secret
//   DTMS_ORIGIN   exactly as written in the key's "Allowed origins" (servers send no Origin by themselves)
//
// Mount:  app.use('/api/dtms', createDtmsRouter({ requireLogin }));
// requireLogin MUST be your real session check. Without it anyone who can reach this URL can file
// documents under the DTMS key owner's name.
// ============================================================
import express from 'express';
import multer from 'multer';

const TRACK = /^[A-Za-z0-9-]{1,40}$/;
const FILE_ID = /^\d{1,12}$/;

export function createDtmsRouter({ requireLogin }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 10 } });

  const authHeaders = () => ({ 'X-API-Token': process.env.DTMS_API_KEY, Origin: process.env.DTMS_ORIGIN });

  async function upstream(path, init = {}) {
    const r = await fetch(process.env.DTMS_BASE + path, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
    return r;
  }

  async function upstreamJson(path, init) {
    const r = await upstream(path, init);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { detail: text.slice(0, 200) }; }
    return { status: r.status, body };
  }

  // ---- tiny TTL cache (successful reads only) ----
  const cache = new Map();
  async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.val;
    const val = await fn();
    if (val.status === 200) cache.set(key, { at: Date.now(), val });
    return val;
  }
  const clearDocumentCache = () => { for (const k of cache.keys()) if (k.startsWith('doc:')) cache.delete(k); };

  const send = (res, { status, body }) => res.status(status).json(body);
  const unreachable = (res) => res.status(502).json({ detail: 'DTMS could not be reached.' });

  router.use(requireLogin);

  // Find the exact email to route to (cached 10 min)
  router.get('/signatories', async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      send(res, await cached('sig:' + qs, 10 * 60_000, () => upstreamJson('document/public/signatories/?' + qs)));
    } catch { unreachable(res); }
  });

  // Newest submissions with their status (cached 45 s)
  router.get('/documents', async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      send(res, await cached('doc:list:' + qs, 45_000, () => upstreamJson('document/public/documents/?' + qs)));
    } catch { unreachable(res); }
  });

  // One document, including who has signed (cached 30 s)
  router.get('/documents/:tn', async (req, res) => {
    if (!TRACK.test(req.params.tn)) return res.status(404).json({ detail: 'Document not found.' });
    try {
      send(res, await cached('doc:one:' + req.params.tn, 30_000, () =>
        upstreamJson(`document/public/documents/${req.params.tn}/`)));
    } catch { unreachable(res); }
  });

  // The PDF itself (signed copy once people have signed). Never cached.
  router.get('/documents/:tn/files/:id', async (req, res) => {
    if (!TRACK.test(req.params.tn) || !FILE_ID.test(req.params.id)) return res.status(404).json({ detail: 'File not found.' });
    try {
      const r = await upstream(`document/public/documents/${req.params.tn}/files/${req.params.id}/`);
      if (!r.ok) return res.status(r.status).json({ detail: 'File not available.' });
      res.set('Content-Type', r.headers.get('content-type') || 'application/pdf');
      const disp = r.headers.get('content-disposition');
      if (disp) res.set('Content-Disposition', disp);
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch { unreachable(res); }
  });

  // Create a document and route it. Not retried automatically: the client checks for a duplicate first.
  router.post('/submit', upload.array('files', 10), async (req, res) => {
    try {
      const form = new FormData();
      for (const f of req.files || []) {
        form.append('files', new Blob([f.buffer], { type: 'application/pdf' }), f.originalname);
      }
      for (const k of ['title', 'requestor', 'position', 'message', 'signatories']) {
        if (req.body[k] !== undefined) form.append(k, req.body[k]);
      }
      const out = await upstreamJson('document/public/submit/', { method: 'POST', body: form });
      if (out.status === 201) clearDocumentCache();   // so the duplicate check sees it straight away
      send(res, out);
    } catch { unreachable(res); }
  });

  return router;
}
