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

// Probe v5 — testea con from/to explícitos (cubrir todo el mes) y endpoints analíticos
async function probe() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const isoFrom = monthStart.toISOString();
  const isoTo = now.toISOString();
  const enc = encodeURIComponent;

  console.log(`Mes: from=${isoFrom}  to=${isoTo}\n`);

  console.log('═══ /sessions CON from/to (probar si filtra el mes completo) ═══');
  for (const p of [
    `/sessions?include-messages=false&from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    `/sessions?include-messages=false&from=${enc(isoFrom)}&to=${enc(isoTo)}&pag=true`,
    `/sessions?from=${enc(isoFrom)}&to=${enc(isoTo)}`
  ]) {
    try {
      const r = await fetch(BASE + p, { headers: { 'access-token': TOKEN } });
      const txt = await r.text();
      console.log(`[${r.status}] ${p}\n   → ${txt.slice(0, 400).replace(/\s+/g, ' ')}`);
    } catch (e) { console.log(`ERR ${p}: ${e.message}`); }
  }

  console.log('\n═══ /chats CON from/to ISO completo ═══');
  for (const p of [
    `/chats?from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    `/chats?from=${enc(isoFrom)}&to=${enc(isoTo)}&pag=true`,
    `/chats?from=${enc(isoFrom)}&to=${enc(isoTo)}&include-messages=false`
  ]) {
    try {
      const r = await fetch(BASE + p, { headers: { 'access-token': TOKEN } });
      const txt = await r.text();
      console.log(`[${r.status}] ${p}\n   → ${txt.slice(0, 400).replace(/\s+/g, ' ')}`);
    } catch (e) { console.log(`ERR ${p}: ${e.message}`); }
  }

  console.log('\n═══ Posibles endpoints analíticos / agregados ═══');
  const analyticPaths = [
    '/sessions/count', `/sessions/count?from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    '/sessions/total', `/sessions/total?from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    '/analytics', '/analytics/sessions', `/analytics/sessions?from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    '/analytics/totals', '/analytics/conversations',
    '/dashboard', '/dashboard/totals',
    '/business', '/businesses',
    '/businesses/edesal',
    '/me', '/whoami',
    '/totals', `/totals?from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    '/reports/summary', `/reports/summary?from=${enc(isoFrom)}&to=${enc(isoTo)}`,
    '/agents/sessions',
    '/channels',
    '/channels/edesal-whatsapp-5492664665277/sessions',
    '/channels/edesal-whatsapp-5492664665277/stats'
  ];
  for (const p of analyticPaths) {
    try {
      const r = await fetch(BASE + p, { headers: { 'access-token': TOKEN } });
      const txt = await r.text();
      const sample = txt.slice(0, 220).replace(/\s+/g, ' ');
      console.log(`[${r.status}] ${p}\n   → ${sample}`);
    } catch (e) { console.log(`ERR ${p}: ${e.message}`); }
  }

  console.log('\n═══ Última sesión de la pagina 2 (verificar a qué fecha llegó la paginación) ═══');
  try {
    let url = `${BASE}/sessions?include-messages=false`;
    let p = 0;
    while (url && p < 3) {
      const r = await fetch(url, { headers: { 'access-token': TOKEN } });
      const data = await r.json();
      const items = data.items || [];
      const first = items[0]?.creationTime;
      const last = items[items.length - 1]?.creationTime;
      console.log(`page ${p}: items=${items.length} primer=${first} último=${last}`);
      url = data.nextPage || null;
      p++;
    }
  } catch (e) { console.log('error en pagineo:', e.message); }

  console.log('\n═══ END PROBE v5 ═══');
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
