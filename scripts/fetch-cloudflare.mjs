// Corre en GitHub Actions (Node 20+, fetch global)
// Consulta Cloudflare GraphQL Analytics API y escribe cloudflare-stats.json

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const TOKEN   = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;

if (!TOKEN || !ZONE_ID) {
  console.error('Faltan vars: CLOUDFLARE_API_TOKEN o CLOUDFLARE_ZONE_ID');
  process.exit(1);
}

// Países más comunes como origen de ataque, con flag emoji + lat/lon (capital o ciudad principal)
const COUNTRY_MAP = {
  CN:{ name:'CHINA',         flag:'🇨🇳', lat:39.9,  lon:116.4 },
  RU:{ name:'RUSIA',         flag:'🇷🇺', lat:55.75, lon:37.6 },
  US:{ name:'EE.UU.',        flag:'🇺🇸', lat:38.9,  lon:-77.0 },
  IN:{ name:'INDIA',         flag:'🇮🇳', lat:28.6,  lon:77.2 },
  BR:{ name:'BRASIL',        flag:'🇧🇷', lat:-23.5, lon:-46.6 },
  KR:{ name:'COREA SUR',     flag:'🇰🇷', lat:37.5,  lon:127.0 },
  KP:{ name:'COREA NORTE',   flag:'🇰🇵', lat:39.0,  lon:125.7 },
  IR:{ name:'IRÁN',          flag:'🇮🇷', lat:35.7,  lon:51.4 },
  VN:{ name:'VIETNAM',       flag:'🇻🇳', lat:21.0,  lon:105.8 },
  DE:{ name:'ALEMANIA',      flag:'🇩🇪', lat:52.5,  lon:13.4 },
  NL:{ name:'PAÍSES BAJOS',  flag:'🇳🇱', lat:52.4,  lon:4.9 },
  UA:{ name:'UCRANIA',       flag:'🇺🇦', lat:50.4,  lon:30.5 },
  RO:{ name:'RUMANIA',       flag:'🇷🇴', lat:44.4,  lon:26.1 },
  FR:{ name:'FRANCIA',       flag:'🇫🇷', lat:48.9,  lon:2.3 },
  GB:{ name:'REINO UNIDO',   flag:'🇬🇧', lat:51.5,  lon:-0.13 },
  TR:{ name:'TURQUÍA',       flag:'🇹🇷', lat:41.0,  lon:28.97 },
  TW:{ name:'TAIWÁN',        flag:'🇹🇼', lat:25.0,  lon:121.5 },
  CA:{ name:'CANADÁ',        flag:'🇨🇦', lat:45.4,  lon:-75.7 },
  ID:{ name:'INDONESIA',     flag:'🇮🇩', lat:-6.2,  lon:106.8 },
  TH:{ name:'TAILANDIA',     flag:'🇹🇭', lat:13.7,  lon:100.5 },
  PK:{ name:'PAKISTÁN',      flag:'🇵🇰', lat:33.7,  lon:73.05 },
  SG:{ name:'SINGAPUR',      flag:'🇸🇬', lat:1.35,  lon:103.8 },
  HK:{ name:'HONG KONG',     flag:'🇭🇰', lat:22.3,  lon:114.2 },
  PH:{ name:'FILIPINAS',     flag:'🇵🇭', lat:14.6,  lon:120.98 },
  AR:{ name:'ARGENTINA',     flag:'🇦🇷', lat:-34.6, lon:-58.4 },
  MX:{ name:'MÉXICO',        flag:'🇲🇽', lat:19.4,  lon:-99.1 },
  CO:{ name:'COLOMBIA',      flag:'🇨🇴', lat:4.7,   lon:-74.07 },
  CL:{ name:'CHILE',         flag:'🇨🇱', lat:-33.4, lon:-70.6 },
  PE:{ name:'PERÚ',          flag:'🇵🇪', lat:-12.05,lon:-77.04 },
  JP:{ name:'JAPÓN',         flag:'🇯🇵', lat:35.7,  lon:139.69 },
  AU:{ name:'AUSTRALIA',     flag:'🇦🇺', lat:-33.87,lon:151.2 },
  PL:{ name:'POLONIA',       flag:'🇵🇱', lat:52.23, lon:21.01 },
  ES:{ name:'ESPAÑA',        flag:'🇪🇸', lat:40.4,  lon:-3.7 },
  IT:{ name:'ITALIA',        flag:'🇮🇹', lat:41.9,  lon:12.5 },
  ZA:{ name:'SUDÁFRICA',     flag:'🇿🇦', lat:-33.9, lon:18.4 },
  EG:{ name:'EGIPTO',        flag:'🇪🇬', lat:30.04, lon:31.24 },
  NG:{ name:'NIGERIA',       flag:'🇳🇬', lat:9.05,  lon:7.5 },
  BD:{ name:'BANGLADESH',    flag:'🇧🇩', lat:23.7,  lon:90.4 }
};

const GQL_QUERY = `
query($zoneId: String!, $from: Time!, $to: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneId }) {
      firewallEventsAdaptiveGroups(
        filter: { datetime_geq: $from, datetime_leq: $to }
        limit: 250
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          clientCountryName
          action
        }
      }
      httpRequests1dGroups(
        filter: { date_geq: "2026-04-01", date_leq: "2026-04-26" }
        limit: 50
      ) {
        sum { requests threats }
        dimensions { date }
      }
    }
  }
}
`;

async function gql(query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); }
  catch { throw new Error(`No JSON: ${txt.slice(0, 200)}`); }
  if (data.errors) throw new Error('GraphQL: ' + JSON.stringify(data.errors));
  return data.data;
}

async function main() {
  const now = new Date();
  const from24h = new Date(now.getTime() - 24 * 3600 * 1000);

  const result = {
    totalBlocked: 0,
    threats24h: 0,
    requests24h: 0,
    actions: {},
    byCountry: [],
    ts: Date.now(),
    _meta: { ok: false, errors: [], rawCountriesUnknown: [] }
  };

  try {
    const data = await gql(GQL_QUERY, {
      zoneId: ZONE_ID,
      from: from24h.toISOString(),
      to: now.toISOString()
    });

    const zone = data?.viewer?.zones?.[0];
    if (!zone) throw new Error('Zone no encontrada en respuesta');

    // Eventos de firewall agrupados por país y action
    const byCountryMap = new Map();
    const actions = {};
    let total = 0;
    const unknownCountries = new Set();

    for (const ev of (zone.firewallEventsAdaptiveGroups || [])) {
      const code = ev.dimensions.clientCountryName;       // CF devuelve código de 2 letras
      const action = ev.dimensions.action;
      const c = ev.count;
      total += c;
      actions[action] = (actions[action] || 0) + c;

      if (!byCountryMap.has(code)) byCountryMap.set(code, 0);
      byCountryMap.set(code, byCountryMap.get(code) + c);
    }

    // Construir array byCountry usando COUNTRY_MAP
    const ranking = [...byCountryMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => {
        const meta = COUNTRY_MAP[code];
        if (!meta) { unknownCountries.add(code); return null; }
        return { code, name: meta.name, flag: meta.flag, lat: meta.lat, lon: meta.lon, count };
      })
      .filter(Boolean);

    // Calcular peso (weight) proporcional al count
    const totalKnown = ranking.reduce((s, r) => s + r.count, 0) || 1;
    for (const r of ranking) r.weight = Math.max(1, Math.round((r.count / totalKnown) * 100));

    result.byCountry = ranking.slice(0, 20);
    result.totalBlocked = total;
    result.actions = actions;
    result._meta.rawCountriesUnknown = [...unknownCountries].slice(0, 30);

    // Threats / requests del mes (httpRequests1dGroups)
    const monthGroups = zone.httpRequests1dGroups || [];
    let monthRequests = 0, monthThreats = 0;
    for (const g of monthGroups) {
      monthRequests += g.sum?.requests || 0;
      monthThreats  += g.sum?.threats  || 0;
    }
    result.requests24h = monthRequests;
    result.threats24h  = monthThreats;

    result._meta.ok = total > 0;
    console.log(`Total blocked 24h: ${total}, ${ranking.length} países conocidos, ${unknownCountries.size} desconocidos`);
    console.log(`Top 5: ${ranking.slice(0,5).map(r => `${r.code}:${r.count}`).join(' ')}`);
    console.log(`Acciones: ${JSON.stringify(actions)}`);
    if (unknownCountries.size) console.log(`Países sin mapping: ${[...unknownCountries].slice(0,10).join(', ')}`);
  } catch (e) {
    console.error(e);
    result._meta.errors.push(e.message);
  }

  // Si fallamos pero hay JSON anterior bueno, lo preservamos
  if (!result._meta.ok && existsSync('cloudflare-stats.json')) {
    const prev = JSON.parse(readFileSync('cloudflare-stats.json', 'utf8'));
    if (prev._meta?.ok) {
      console.log('Preservando cloudflare-stats.json anterior.');
      return;
    }
  }

  writeFileSync('cloudflare-stats.json', JSON.stringify(result, null, 2));
  console.log('cloudflare-stats.json escrito');
}

main().catch(err => { console.error(err); process.exit(1); });
