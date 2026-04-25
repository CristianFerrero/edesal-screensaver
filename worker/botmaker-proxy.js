// ─────────────────────────────────────────────────────────────────────
// Cloudflare Worker — Botmaker proxy
// Despliegue:
//   1. Crear un Worker nuevo en https://dash.cloudflare.com → Workers
//   2. Pegar este archivo
//   3. En Settings → Variables → Add secret:
//        Name:  BOTMAKER_TOKEN
//        Value: <tu nuevo access-token de Botmaker>
//   4. (Opcional) restringir CORS a tu dominio de GH Pages cambiando ALLOW_ORIGIN
//   5. Anotar la URL del worker (ej: https://botmaker-edesal.tu-cuenta.workers.dev)
//      y pegarla en oficina-virtual.html en la constante BOTMAKER_PROXY_URL
// ─────────────────────────────────────────────────────────────────────

const ALLOW_ORIGIN = '*';   // Cambiar a 'https://cristianferrero.github.io' para producción

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin || ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
});

const json = (data, status = 200, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin) }
  });

async function bm(path, token) {
  const r = await fetch(`https://go.botmaker.com${path}`, {
    headers: { 'access-token': token, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error(`Botmaker ${path} → ${r.status}`);
  return r.json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ALLOW_ORIGIN;
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    const token = env.BOTMAKER_TOKEN;
    if (!token) return json({ error: 'BOTMAKER_TOKEN no configurado en el Worker' }, 500, origin);

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'snapshot';

    try {
      switch (action) {

        case 'snapshot': {
          // Devuelve todo lo que necesita el dashboard en una sola request
          // VERIFICAR estos endpoints contra los docs de Botmaker
          // (https://api-docs.botmaker.com/) y ajustar paths/parsing si fuese necesario.

          // Conversaciones activas en este momento (por canal)
          // Posibles paths reales: /api/v1.0/sessions, /api/v2.0/customers/active...
          let active = [];
          try {
            active = await bm('/api/v1.0/sessions/active', token);
          } catch (_) { /* fallback abajo */ }

          const byChannel = { whatsapp: 0, webchat: 0, callcenter: 0 };
          if (Array.isArray(active)) {
            for (const s of active) {
              const ch = (s.platform || s.channel || s.platformContactId || '').toLowerCase();
              if (ch.includes('whatsapp') || ch.includes('wa-')) byChannel.whatsapp++;
              else if (ch.includes('web') || ch.includes('chat')) byChannel.webchat++;
              else if (ch.includes('phone') || ch.includes('call')) byChannel.callcenter++;
            }
          }

          // Total atendidos del mes — VERIFICAR endpoint
          // Ej: /api/v1.0/stats?period=month, /api/v1.0/conversations/resolved?from=...
          let monthTotal = null;
          try {
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            const to   = new Date().toISOString();
            const stats = await bm(`/api/v1.0/stats/conversations?from=${from}&to=${to}`, token);
            monthTotal = stats.totalResolved ?? stats.total ?? null;
          } catch (_) { /* fallback abajo */ }

          return json({
            channels: byChannel,
            monthTotal,
            ts: Date.now()
          }, 200, origin);
        }

        // Endpoint de debug — devuelve la respuesta cruda de un path para ayudar a mapear
        case 'raw': {
          const path = url.searchParams.get('path');
          if (!path) return json({ error: 'falta param path' }, 400, origin);
          const data = await bm(path, token);
          return json(data, 200, origin);
        }

        default:
          return json({ error: 'action desconocida' }, 400, origin);
      }
    } catch (err) {
      return json({ error: err.message }, 502, origin);
    }
  }
};
