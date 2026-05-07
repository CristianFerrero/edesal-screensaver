// ─────────────────────────────────────────────────────────────────────────────
// Monitor de disponibilidad — Oficina Virtual EDESAL
// Cloudflare Worker con Cron Trigger (1 min) + KV + alertas Teams
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_URL = 'https://www.oficinavirtualedesal.com.ar/';
const TIMEOUT_MS = 15000;
const RETENTION_HOURS = 25;
const ALERT_DEBOUNCE_MS = 60_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      switch (url.pathname) {
        case '/status':
          return await cachedJson(request, ctx, 'status', 30,
            () => getLatest(env));

        case '/history': {
          const limit = clampInt(url.searchParams.get('limit'), 60, 1, 1500);
          return await cachedJson(request, ctx, `history-${limit}`, 30,
            () => getHistory(env, limit));
        }

        case '/stats':
          return await cachedJson(request, ctx, 'stats', 30,
            () => getStats(env));

        case '/check': {
          const reg = await runCheck(env, ctx);
          return jsonResponse(reg);
        }

        case '/debug': {
          const dbg = {
            tokenLoaded: !!env.MONITOR_TOKEN,
            kvBound: !!env.MONITOR_DB,
            teamsConfigured: !!env.TEAMS_WEBHOOK_URL,
            kvReads: {},
            probe: null
          };
          if (env.MONITOR_DB) {
            try {
              const last = await env.MONITOR_DB.get('_last_state', 'json');
              dbg.kvReads.lastStateType = last === null ? 'null' : typeof last;
              dbg.kvReads.lastStateOnline = last?.online;
            } catch (e) { dbg.kvReads.lastStateError = e.message; }
            try {
              const recent = await env.MONITOR_DB.get('_history_recent', 'json');
              dbg.kvReads.historyRecentType = recent === null ? 'null' : (Array.isArray(recent) ? 'array' : typeof recent);
              dbg.kvReads.historyRecentLength = Array.isArray(recent) ? recent.length : null;
            } catch (e) { dbg.kvReads.historyRecentError = e.message; }
          }
          try {
            const opts = {};
            if (env.MONITOR_TOKEN) opts.headers = { 'X-Monitor-Token': env.MONITOR_TOKEN };
            const r = await fetch(TARGET_URL, opts);
            dbg.probe = {
              status: r.status,
              cfRay: r.headers.get('cf-ray'),
              cfMitigated: r.headers.get('cf-mitigated'),
              server: r.headers.get('server')
            };
          } catch (e) { dbg.probe = { error: e.message }; }
          return jsonResponse(dbg);
        }

        case '/dashboard':
          return htmlResponse(getDashboard(await getHistory(env, 50)));

        case '/':
        default: {
          const reg = await runCheck(env, ctx);
          return jsonResponse(reg);
        }
      }
    } catch (err) {
      return jsonResponse({ error: err.message || String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env, ctx));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CORE — chequeo
// ─────────────────────────────────────────────────────────────────────────────

async function runCheck(env, ctx) {
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();
  let status = 'ERROR';
  let online = false;
  let latency = null;
  let error = null;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const opts = {
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    };
    if (env.MONITOR_TOKEN) opts.headers = { 'X-Monitor-Token': env.MONITOR_TOKEN };

    const url = TARGET_URL + (TARGET_URL.includes('?') ? '&' : '?') + '_mon=' + Date.now();
    const res = await fetch(url, opts);
    clearTimeout(t);
    status = res.status;
    online = typeof status === 'number' && status < 500;
    latency = Date.now() - startedAt;
  } catch (e) {
    status = 'ERROR';
    error = e.name === 'AbortError' ? 'TIMEOUT' : (e.message || 'NETWORK');
    latency = Date.now() - startedAt;
  }

  const reg = { timestamp, status, online, latency, error };

  if (env.MONITOR_DB) {
    try {
      // Una sola lectura: el array compacto (incluye el último en [0])
      const recent = await env.MONITOR_DB.get('_history_recent', 'json').catch(() => null);
      const history = Array.isArray(recent) ? recent : [];
      const prev = history[0] || null;

      history.unshift(reg);
      if (history.length > 1500) history.length = 1500;

      // Una sola escritura por cron (cabe holgado en 1000 writes/dia incluso con cron 1m)
      await env.MONITOR_DB.put('_history_recent', JSON.stringify(history))
        .catch(e => console.error('put history fail:', e));

      if (prev && prev.online !== undefined && prev.online !== online) {
        ctx.waitUntil(maybeAlert(env, online, reg, prev));
      }
    } catch (e) {
      console.error('runCheck KV block fail:', e);
      reg._kvError = e.message;
    }
  }

  return reg;
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERTAS — Microsoft Teams (Workflows / Adaptive Card)
// ─────────────────────────────────────────────────────────────────────────────

async function maybeAlert(env, isUp, current, prev) {
  if (!env.TEAMS_WEBHOOK_URL) return;

  const lastAlert = await env.MONITOR_DB.get('_last_alert_at', 'json');
  if (lastAlert && Date.now() - lastAlert < ALERT_DEBOUNCE_MS) return;

  const titulo = isUp ? 'Sitio RECUPERADO' : 'Sitio CAIDO';
  const color = isUp ? 'Good' : 'Attention';
  const icon = isUp ? '✅' : '\u{1F6A8}';
  const downSince = prev?.timestamp ? formatDur(prev.timestamp, current.timestamp) : '?';

  const facts = isUp
    ? [
        { title: 'Estado', value: `${icon} UP` },
        { title: 'Codigo HTTP', value: String(current.status) },
        { title: 'Latencia', value: `${current.latency} ms` },
        { title: 'Caida duro', value: downSince }
      ]
    : [
        { title: 'Estado', value: `${icon} DOWN` },
        { title: 'Codigo HTTP', value: String(current.status) },
        { title: 'Error', value: current.error || '-' },
        { title: 'Latencia', value: `${current.latency} ms` }
      ];

  const adaptiveCard = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body: [
            {
              type: 'TextBlock',
              text: `${icon} ${titulo}`,
              weight: 'Bolder',
              size: 'Large',
              color: color,
              wrap: true
            },
            {
              type: 'TextBlock',
              text: 'Oficina Virtual EDESAL',
              isSubtle: true,
              spacing: 'None',
              wrap: true
            },
            { type: 'FactSet', facts },
            {
              type: 'TextBlock',
              text: `Detectado: ${new Date(current.timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`,
              isSubtle: true,
              size: 'Small',
              spacing: 'Medium',
              wrap: true
            }
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'Ver Dashboard',
              url: 'https://cristianferrero.github.io/edesal-screensaver/monitor-ov.html'
            },
            {
              type: 'Action.OpenUrl',
              title: 'Abrir Oficina Virtual',
              url: TARGET_URL
            }
          ]
        }
      }
    ]
  };

  try {
    const r = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adaptiveCard)
    });
    if (r.ok) {
      await env.MONITOR_DB.put('_last_alert_at', JSON.stringify(Date.now()));
    } else {
      console.error('Teams webhook fallo:', r.status, await r.text());
    }
  } catch (e) {
    console.error('Teams webhook error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LECTURAS — KV
// ─────────────────────────────────────────────────────────────────────────────

async function getLatest(env) {
  if (!env.MONITOR_DB) return defaultLatest();
  try {
    // Derivamos el ultimo del array (evitamos una key separada)
    const recent = await env.MONITOR_DB.get('_history_recent', 'json');
    if (Array.isArray(recent) && recent[0]) return recent[0];
    return defaultLatest();
  } catch (e) {
    console.error('getLatest fail:', e);
    return defaultLatest();
  }
}
function defaultLatest() {
  return { timestamp: null, status: null, online: null, latency: null, error: null };
}

async function getHistory(env, limit) {
  if (!env.MONITOR_DB) return [];
  try {
    const recent = await env.MONITOR_DB.get('_history_recent', 'json');
    if (!Array.isArray(recent)) return [];
    return recent.slice(0, limit);
  } catch (e) {
    console.error('getHistory fail:', e);
    return [];
  }
}

async function getStats(env) {
  const all = await getHistory(env, 1500);
  if (all.length === 0) {
    return { total: 0, online: 0, offline: 0, uptime: 0, avgLatency: null, lastDown: null, lastUp: null };
  }
  const online = all.filter(r => r.online).length;
  const offline = all.length - online;
  const uptime = (online / all.length) * 100;
  const lats = all.filter(r => typeof r.latency === 'number').map(r => r.latency);
  const avgLatency = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
  const lastDown = all.find(r => !r.online)?.timestamp || null;
  const lastUp = all.find(r => r.online)?.timestamp || null;
  return {
    total: all.length,
    online,
    offline,
    uptime: +uptime.toFixed(2),
    avgLatency,
    lastDown,
    lastUp
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

// Cachea la respuesta en Cloudflare Cache API por TTL segundos.
// Evita golpear KV en cada request del frontend (que refresca cada 30s).
async function cachedJson(request, ctx, key, ttl, producer) {
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = '/__cache__/' + key;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('X-Cache', 'HIT');
    Object.entries(corsHeaders()).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }

  const data = await producer();
  const body = JSON.stringify(data);
  const fresh = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Cache': 'MISS'
    }
  });

  ctx.waitUntil(cache.put(cacheKey, fresh.clone()));

  Object.entries(corsHeaders()).forEach(([k, v]) => fresh.headers.set(k, v));
  return fresh;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders()
    }
  });
}

function htmlResponse(body) {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function formatDur(t1, t2) {
  if (!t1 || !t2) return '?';
  const ms = new Date(t2) - new Date(t1);
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}min`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD HTML — fallback estilo original
// ─────────────────────────────────────────────────────────────────────────────

function getDashboard(historial) {
  const total = historial.length;
  const online = historial.filter(x => x.online).length;
  const offline = total - online;
  const uptime = total ? ((online / total) * 100).toFixed(1) : 0;

  const rows = historial.slice(0, 50).map(r => `
    <tr>
      <td>${new Date(r.timestamp).toLocaleString('es-AR')}</td>
      <td style="color: ${r.online ? '#10b981' : '#ef4444'}">${r.online ? '✅ Online' : '❌ Offline'}</td>
      <td>${r.status}</td>
      <td>${r.latency != null ? r.latency + ' ms' : '-'}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monitor</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;padding:20px}
    .container{max-width:1000px;margin:0 auto}
    .header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:30px;border-radius:12px;margin-bottom:30px}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-bottom:30px}
    .stat{background:#fff;padding:20px;border-radius:12px;text-align:center}
    .stat h3{font-size:12px;color:#666;margin-bottom:10px}
    .stat .valor{font-size:32px;font-weight:bold}
    .tabla{background:#fff;border-radius:12px;overflow:hidden}
    table{width:100%;border-collapse:collapse}
    th{background:#f8f9fa;padding:15px;text-align:left;font-weight:600}
    td{padding:12px 15px;border-bottom:1px solid #e5e7eb}
    .btn{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:10px 20px;border:none;border-radius:6px;cursor:pointer;margin-top:20px}
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Monitor de Disponibilidad</h1></div>
    <div class="stats">
      <div class="stat"><h3>Total</h3><div class="valor">${total}</div></div>
      <div class="stat"><h3>Online</h3><div class="valor" style="color:#10b981">${online}</div></div>
      <div class="stat"><h3>Offline</h3><div class="valor" style="color:#ef4444">${offline}</div></div>
      <div class="stat"><h3>Uptime</h3><div class="valor" style="color:#f59e0b">${uptime}%</div></div>
    </div>
    <div class="tabla">
      <table>
        <thead><tr><th>Fecha y Hora</th><th>Estado</th><th>Codigo</th><th>Latencia</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <center><button class="btn" onclick="location.reload()">Actualizar</button></center>
  </div>
</body>
</html>`;
}
