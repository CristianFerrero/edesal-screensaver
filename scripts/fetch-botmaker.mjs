// Corre en GitHub Actions (Node 20+, fetch global)
// Consulta Botmaker y escribe bot-stats.json en la raíz del repo.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const TOKEN = process.env.BOTMAKER_TOKEN;
if (!TOKEN) {
  console.error('Falta BOTMAKER_TOKEN (secret del repo).');
  process.exit(1);
}

const BASE = 'https://api.botmaker.com/v2.0';

async function bm(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'access-token': TOKEN, 'Content-Type': 'application/json' },
    ...opts
  });
  const txt = await r.text();
  if (!r.ok) {
    const sample = txt.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`${path} → HTTP ${r.status} | body: ${sample}`);
  }
  try { return JSON.parse(txt); } catch { return txt; }
}

async function fetchJson(path) {
  const r = await fetch(BASE + path, {
    headers: { 'access-token': TOKEN, 'Content-Type': 'application/json' }
  });
  const txt = await r.text();
  return { status: r.status, body: txt ? (() => { try { return JSON.parse(txt); } catch { return txt; } })() : null };
}
async function fetchJsonAbs(absUrl) {
  const r = await fetch(absUrl, {
    headers: { 'access-token': TOKEN, 'Content-Type': 'application/json' }
  });
  const txt = await r.text();
  return { status: r.status, body: txt ? (() => { try { return JSON.parse(txt); } catch { return txt; } })() : null };
}

// Probe v3 — dumpea estructura completa de /sessions y /chats, cuenta chats del mes por canal
async function probe() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const ymdFrom = monthStart.toISOString().slice(0, 10);
  const ymdTo   = now.toISOString().slice(0, 10);

  console.log('═══ ESTRUCTURA · /sessions ═══');
  try {
    const { status, body } = await fetchJson('/sessions?include-messages=false');
    console.log(`status: ${status}`);
    console.log(`items.length: ${body.items?.length}`);
    console.log(`nextPage: ${body.nextPage ? 'sí' : 'no'}`);
    if (body.items?.length) {
      console.log('PRIMER ITEM completo:');
      console.log(JSON.stringify(body.items[0], null, 2).slice(0, 1200));
    }
  } catch (e) { console.log('error:', e.message); }

  console.log('\n═══ ESTRUCTURA · /chats?from=mes&to=hoy ═══');
  try {
    const { status, body } = await fetchJson(`/chats?from=${ymdFrom}&to=${ymdTo}`);
    console.log(`status: ${status}`);
    console.log(`items.length página 1: ${body.items?.length}`);
    if (body.items?.length) {
      console.log('PRIMER ITEM completo:');
      console.log(JSON.stringify(body.items[0], null, 2).slice(0, 1200));
    }
  } catch (e) { console.log('error:', e.message); }

  console.log('\n═══ CONTEO · chats del mes por canal (paginado, máx 50 páginas) ═══');
  try {
    let total = 0;
    const byChannel = {};
    const channelsRaw = new Set();
    let url = `${BASE}/chats?from=${ymdFrom}&to=${ymdTo}`;
    let pages = 0;
    while (url && pages < 50) {
      const { status, body } = await fetchJsonAbs(url);
      if (status !== 200) { console.log(`page ${pages} status ${status}, abortando`); break; }
      for (const it of body.items || []) {
        total++;
        const ch = it.chat?.channelId || it.channelId || '';
        channelsRaw.add(ch);
        let bucket = 'other';
        const lc = ch.toLowerCase();
        if (lc.includes('whatsapp')) bucket = 'whatsapp';
        else if (lc.includes('webchat') || lc.includes('web') || lc.includes('site')) bucket = 'webchat';
        else if (lc.includes('phone') || lc.includes('call') || lc.includes('agent')) bucket = 'callcenter';
        byChannel[bucket] = (byChannel[bucket] || 0) + 1;
      }
      url = body.nextPage || null;
      pages++;
    }
    console.log(`páginas leídas: ${pages}`);
    console.log(`TOTAL chats del mes (hasta donde paginé): ${total}`);
    console.log('por canal:', JSON.stringify(byChannel));
    console.log('canales únicos vistos:', [...channelsRaw].join('  |  '));
  } catch (e) { console.log('error en conteo:', e.message); }

  console.log('\n═══ END PROBE v3 ═══');
}

function classifyChannel(s) {
  // Botmaker puede usar distintos campos: platform / channel / platformContactId, etc.
  // VERIFICAR contra la respuesta real (correr el workflow una vez y mirar el log).
  const raw = (s.platform || s.channel || s.platformContactId || s.source || '').toString().toLowerCase();
  if (raw.includes('whatsapp') || raw.includes('wa-') || raw.includes('wapp')) return 'whatsapp';
  if (raw.includes('web') || raw.includes('chat') || raw.includes('site')) return 'webchat';
  if (raw.includes('phone') || raw.includes('call') || raw.includes('agent')) return 'callcenter';
  return null;
}

async function main() {
  // Si el workflow se dispara con DEBUG=1, sólo prueba endpoints y termina sin escribir el JSON
  if (process.env.DEBUG === '1') {
    await probe();
    return;
  }

  const result = {
    channels: { whatsapp: 0, webchat: 0, callcenter: 0 },
    monthTotal: null,
    ts: Date.now(),
    _meta: { ok: false, errors: [] }
  };

  // ───── Sesiones activas (por canal) ─────
  // VERIFICAR este endpoint contra https://api-docs.botmaker.com/
  // Si no es éste, ajustar el path o usar uno equivalente (ej. /api/v2.0/customers/...).
  try {
    const active = await bm('/api/v1.0/sessions/active');
    if (Array.isArray(active)) {
      console.log(`sessions/active → ${active.length} items, sample:`, active[0] ? JSON.stringify(active[0]).slice(0, 300) : 'empty');
      for (const s of active) {
        const ch = classifyChannel(s);
        if (ch) result.channels[ch]++;
      }
      result._meta.ok = true;
    } else {
      console.log('sessions/active no devolvió un array:', typeof active);
    }
  } catch (e) {
    console.warn('Error en sessions/active:', e.message);
    result._meta.errors.push(`sessions/active: ${e.message}`);
  }

  // ───── Total mensual de conversaciones resueltas ─────
  // VERIFICAR endpoint también (puede ser /api/v1.0/stats/conversations o /api/v2.0/...).
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const to   = new Date().toISOString();
    const stats = await bm(`/api/v1.0/stats/conversations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    console.log('stats/conversations →', JSON.stringify(stats).slice(0, 300));
    result.monthTotal = stats.totalResolved ?? stats.total ?? stats.count ?? null;
    if (result.monthTotal != null) result._meta.ok = true;
  } catch (e) {
    console.warn('Error en stats/conversations:', e.message);
    result._meta.errors.push(`stats/conversations: ${e.message}`);
  }

  // Si no aprendimos nada y existe un JSON anterior con datos, no pisar con ceros.
  if (!result._meta.ok && existsSync('bot-stats.json')) {
    const prev = JSON.parse(readFileSync('bot-stats.json', 'utf8'));
    if (prev._meta?.ok) {
      console.log('No se obtuvieron datos nuevos — preservando bot-stats.json anterior.');
      return;
    }
  }

  writeFileSync('bot-stats.json', JSON.stringify(result, null, 2));
  console.log('bot-stats.json escrito:', JSON.stringify(result));
}

main().catch(err => { console.error(err); process.exit(1); });
