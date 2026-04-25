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

function bucketChannel(channelId) {
  const lc = (channelId || '').toLowerCase();
  if (lc.includes('whatsapp')) return 'whatsapp';
  if (lc.includes('webchat') || lc.includes('web-chat')) return 'webchat';
  if (lc.includes('phone') || lc.includes('call') || lc.includes('agent') || lc.includes('voip')) return 'callcenter';
  return 'other';
}

async function main() {
  if (process.env.DEBUG === '1') { await probe(); return; }

  const result = {
    channels: { whatsapp: 0, webchat: 0, callcenter: 0 },
    monthTotal: 0,
    monthByChannel: { whatsapp: 0, webchat: 0, callcenter: 0, other: 0 },
    ts: Date.now(),
    _meta: { ok: false, errors: [], pages: 0, channelsRaw: [] }
  };

  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // "Activas" = sesiones creadas en los últimos N minutos (mejor proxy disponible —
    // Botmaker no expone "openSessions" como tal en este endpoint).
    const ACTIVE_WINDOW_MIN = 30;
    const recentCutoff = new Date(now.getTime() - ACTIVE_WINDOW_MIN * 60 * 1000);

    const channelsRaw = new Set();
    const activeByChannel = { whatsapp: 0, webchat: 0, callcenter: 0 };

    let url = `${BASE}/sessions?include-messages=false`;
    let pages = 0;
    let stopBecauseOlderThanMonth = false;

    while (url && pages < 120 && !stopBecauseOlderThanMonth) {
      const r = await fetch(url, {
        headers: { 'access-token': TOKEN, 'Content-Type': 'application/json' }
      });
      if (!r.ok) {
        result._meta.errors.push(`page ${pages}: HTTP ${r.status}`);
        break;
      }
      const data = await r.json();
      const items = data.items || [];
      let pageHadCurrentMonth = false;

      for (const s of items) {
        const ct = new Date(s.creationTime);
        if (isNaN(ct)) continue;
        if (ct < monthStart) continue;
        pageHadCurrentMonth = true;

        const chId = s.chat?.chat?.channelId || s.chat?.channelId || '';
        channelsRaw.add(chId.split('-').slice(0, 2).join('-'));   // ej: "edesal-whatsapp"
        const bucket = bucketChannel(chId);

        result.monthTotal++;
        result.monthByChannel[bucket] = (result.monthByChannel[bucket] || 0) + 1;
        if (ct >= recentCutoff && bucket !== 'other') activeByChannel[bucket]++;
      }

      // /sessions viene ordenado descendente por creationTime → si esta página entera
      // está antes del mes, dejá de paginar
      if (items.length > 0 && !pageHadCurrentMonth) stopBecauseOlderThanMonth = true;

      url = data.nextPage || null;
      pages++;
    }

    result.channels = activeByChannel;
    result._meta.pages = pages;
    result._meta.channelsRaw = [...channelsRaw];
    result._meta.ok = result.monthTotal > 0;

    console.log(`Páginas: ${pages}, total mes: ${result.monthTotal}, simultáneas (${ACTIVE_WINDOW_MIN}min): ${JSON.stringify(activeByChannel)}`);
    console.log(`Canales detectados: ${[...channelsRaw].join(', ')}`);
  } catch (e) {
    console.error(e);
    result._meta.errors.push(e.message);
  }

  // Preservar JSON anterior si fallamos
  if (!result._meta.ok && existsSync('bot-stats.json')) {
    const prev = JSON.parse(readFileSync('bot-stats.json', 'utf8'));
    if (prev._meta?.ok) {
      console.log('Sin datos nuevos — preservando bot-stats.json anterior.');
      return;
    }
  }

  writeFileSync('bot-stats.json', JSON.stringify(result, null, 2));
  console.log('bot-stats.json:', JSON.stringify(result));
}

main().catch(err => { console.error(err); process.exit(1); });
