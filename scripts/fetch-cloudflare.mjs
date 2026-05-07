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
  BD:{ name:'BANGLADESH',    flag:'🇧🇩', lat:23.7,  lon:90.4 },
  NO:{ name:'NORUEGA',       flag:'🇳🇴', lat:59.9,  lon:10.75 },
  FI:{ name:'FINLANDIA',     flag:'🇫🇮', lat:60.17, lon:24.94 },
  KH:{ name:'CAMBOYA',       flag:'🇰🇭', lat:11.55, lon:104.92 },
  MY:{ name:'MALASIA',       flag:'🇲🇾', lat:3.14,  lon:101.69 },
  SA:{ name:'ARABIA SAUDÍ',  flag:'🇸🇦', lat:24.71, lon:46.67 },
  SE:{ name:'SUECIA',        flag:'🇸🇪', lat:59.33, lon:18.06 },
  AM:{ name:'ARMENIA',       flag:'🇦🇲', lat:40.18, lon:44.51 },
  AE:{ name:'EMIRATOS',      flag:'🇦🇪', lat:25.20, lon:55.27 },
  PT:{ name:'PORTUGAL',      flag:'🇵🇹', lat:38.72, lon:-9.14 },
  T1:{ name:'TOR NETWORK',   flag:'🧅', lat:0,     lon:-30 }   // Cloudflare usa "T1" para tráfico vía Tor
};

// Usamos httpRequests1hGroups con countryMap (disponible en Free plan, no requiere WAF Pro+).
// Trae por hora un breakdown por país con count de threats (ataques bloqueados).
const GQL_QUERY = `
query($zoneId: String!, $from: Time!, $to: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneId }) {
      httpRequests1hGroups(
        filter: { datetime_geq: $from, datetime_leq: $to }
        limit: 100
        orderBy: [datetime_DESC]
      ) {
        dimensions { datetime }
        sum {
          requests
          threats
          countryMap {
            clientCountryName
            threats
            requests
          }
        }
      }
    }
  }
}
`;

// Query adicional: serie por día para los últimos 7 días
const GQL_DAILY = `
query($zoneId: String!, $from: Date!, $to: Date!) {
  viewer {
    zones(filter: { zoneTag: $zoneId }) {
      httpRequests1dGroups(
        filter: { date_geq: $from, date_leq: $to }
        limit: 14
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { requests threats }
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
    passed24h: 0,
    actions: {},
    byCountry: [],
    byHour24h: [],
    byDay7d: [],
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

    // Aggregamos las últimas 24 horas: cada hour group tiene un countryMap con threats/requests
    const byCountryThreats = new Map();
    const unknownCountries = new Set();
    let totalThreats = 0;
    let totalRequests = 0;
    const hourly = [];

    for (const hg of (zone.httpRequests1hGroups || [])) {
      const reqs = hg.sum?.requests || 0;
      const thr = hg.sum?.threats || 0;
      totalThreats += thr;
      totalRequests += reqs;
      hourly.push({
        hour: hg.dimensions?.datetime,
        requests: reqs,
        threats: thr,
        passed: Math.max(0, reqs - thr)
      });
      for (const cm of (hg.sum?.countryMap || [])) {
        const code = cm.clientCountryName;
        const t = cm.threats || 0;
        if (t > 0) byCountryThreats.set(code, (byCountryThreats.get(code) || 0) + t);
      }
    }
    // Orden ascendente para gráfico de izquierda a derecha
    result.byHour24h = hourly.sort((a, b) => new Date(a.hour) - new Date(b.hour));

    const ranking = [...byCountryThreats.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => {
        const meta = COUNTRY_MAP[code];
        if (!meta) { unknownCountries.add(code); return null; }
        return { code, name: meta.name, flag: meta.flag, lat: meta.lat, lon: meta.lon, count };
      })
      .filter(Boolean);

    const totalKnown = ranking.reduce((s, r) => s + r.count, 0) || 1;
    for (const r of ranking) r.weight = Math.max(1, Math.round((r.count / totalKnown) * 100));

    result.byCountry = ranking.slice(0, 20);
    result.totalBlocked = totalThreats;
    result.threats24h = totalThreats;
    result.requests24h = totalRequests;
    result.passed24h = Math.max(0, totalRequests - totalThreats);
    result._meta.rawCountriesUnknown = [...unknownCountries].slice(0, 30);

    // ── Datos por día de los últimos 7 días ──
    try {
      const today = new Date();
      const from7d = new Date(today.getTime() - 6 * 86400 * 1000);
      const isoDate = (d) => d.toISOString().slice(0, 10);
      const daily = await gql(GQL_DAILY, {
        zoneId: ZONE_ID,
        from: isoDate(from7d),
        to: isoDate(today)
      });
      const days = daily?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
      result.byDay7d = days.map(d => {
        const reqs = d.sum?.requests || 0;
        const thr = d.sum?.threats || 0;
        return {
          date: d.dimensions?.date,
          requests: reqs,
          threats: thr,
          passed: Math.max(0, reqs - thr)
        };
      });
      console.log(`Datos diarios: ${result.byDay7d.length} días`);
    } catch (e) {
      console.warn('Daily query falló (no crítico):', e.message);
      result._meta.errors.push('daily: ' + e.message);
    }

    result._meta.ok = totalThreats > 0 || totalRequests > 0;
    console.log(`Total threats 24h: ${totalThreats} sobre ${totalRequests} requests`);
    console.log(`Passed 24h: ${result.passed24h}`);
    console.log(`${ranking.length} países conocidos, ${unknownCountries.size} desconocidos`);
    console.log(`Top 5: ${ranking.slice(0,5).map(r => `${r.code}:${r.count}`).join(' ')}`);
    if (unknownCountries.size) console.log(`Países sin mapping: ${[...unknownCountries].slice(0,15).join(', ')}`);
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
