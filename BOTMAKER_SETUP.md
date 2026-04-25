# Botmaker · integración con dashboard OFICINA VIRTUAL

El dashboard se puede alimentar con datos reales de Botmaker (sesiones por canal y total mensual).
Hay dos caminos. **Elegí uno**.

> ⚠️ **Antes de cualquiera**: revocar el access-token actual en Botmaker
> (Configuración → API tokens) y generar uno nuevo. El original quedó expuesto en logs y
> se considera comprometido.

---

## Opción A · GitHub Actions (recomendada — sin servicios externos)

Un workflow corre cada 5 minutos, consulta Botmaker con un secret guardado en GitHub,
y actualiza `bot-stats.json` en el branch `gh-pages`. El dashboard hace fetch a ese
archivo (mismo origen, sin CORS).

**Ventajas**: todo en GitHub, gratis, sin cuentas extra.
**Limitación**: granularidad mínima de 5 minutos (cron de Actions).

### Setup (3 minutos)

1. **Generar nuevo access-token** en Botmaker.
2. En tu repo de GitHub → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `BOTMAKER_TOKEN`
   - Value: el token nuevo
3. Pestaña **Actions** → workflow `Update Botmaker stats` → **Run workflow** (manual) para
   probar la primera corrida. A partir de ahí corre solo cada 5 min.
4. Listo. El dashboard ya está apuntando a `bot-stats.json` por default.

### Verificar endpoints reales

Los paths de Botmaker que usé en `scripts/fetch-botmaker.mjs`
(`/api/v1.0/sessions/active`, `/api/v1.0/stats/conversations`) son una **suposición educada**.
La primera corrida del workflow loguea la respuesta cruda — chequeá los logs de la action
en GitHub. Si los campos no matchean, ajustá `classifyChannel()` o los paths según los
[docs reales](https://api-docs.botmaker.com/).

---

## Opción B · Cloudflare Worker (real-time, cuenta CF requerida)

Worker proxy con el token como secret env var. Ver `worker/botmaker-proxy.js`.

### Setup

1. Crear Worker en https://dash.cloudflare.com → Workers & Pages.
2. Pegar `worker/botmaker-proxy.js` → Deploy.
3. Settings → Variables → Encrypted: `BOTMAKER_TOKEN` = el token nuevo.
4. En `oficina-virtual.html`, cambiar:
   ```js
   const BOT_STATS_SOURCE = 'bot-stats.json';
   ```
   por:
   ```js
   const BOT_STATS_SOURCE = 'https://tu-worker.workers.dev';
   ```

### Restringir CORS (recomendado)

En el Worker, cambiar `ALLOW_ORIGIN = '*'` por `'https://cristianferrero.github.io'` y redeploy.

---

## Cómo se comporta el dashboard

- Si `BOT_STATS_SOURCE` está vacío → datos **simulados** (mock).
- Si la fuente devuelve datos → toman prioridad sobre el mock.
- Si la fuente falla (404, error de red, `_meta.ok=false`) → vuelve al mock automáticamente.

### Forma del JSON esperado

```json
{
  "channels": {
    "whatsapp":   11,
    "webchat":     3,
    "callcenter":  4
  },
  "monthTotal": 19842,
  "ts": 1745000000000,
  "_meta": { "ok": true, "errors": [] }
}
```
