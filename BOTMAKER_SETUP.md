# Botmaker · integración con dashboard OFICINA VIRTUAL

El dashboard puede consumir datos en vivo de Botmaker (sesiones por canal y total mensual)
a través de un Cloudflare Worker que actúa como proxy. El token nunca se expone al navegador.

## ⚠️ Antes de empezar

**Revocar y rotar el access-token actual** en Botmaker (Configuración → API tokens).
El token original quedó expuesto en logs de chat — se considera comprometido.
Generar uno nuevo y NO publicarlo en ningún lugar público.

## 1. Desplegar el Worker (5 minutos, gratis)

1. Entrar a [https://dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**
2. **Create application → Create Worker** → nombre, ej. `botmaker-edesal-proxy`
3. **Edit code** → pegar el contenido de [`worker/botmaker-proxy.js`](worker/botmaker-proxy.js) → **Save & Deploy**
4. Volver al worker → **Settings → Variables → Environment Variables**
5. **Add → Encrypt** (importante: encrypt para que sea secret):
   - Variable name: `BOTMAKER_TOKEN`
   - Value: el access-token NUEVO de Botmaker
6. Anotar la URL pública del worker (ej. `https://botmaker-edesal-proxy.tu-cuenta.workers.dev`)

## 2. Conectar el dashboard

Abrir [`oficina-virtual.html`](oficina-virtual.html), buscar la constante `BOTMAKER_PROXY_URL`
y pegar la URL del Worker:

```js
const BOTMAKER_PROXY_URL = 'https://botmaker-edesal-proxy.tu-cuenta.workers.dev';
```

Si la URL queda vacía (`''`), el dashboard sigue funcionando con datos simulados
(comportamiento por defecto). Subir el cambio al repo.

## 3. Verificar y mapear los endpoints reales

Los paths de Botmaker (`/api/v1.0/sessions/active`, `/api/v1.0/stats/conversations`)
fueron supuestos. **Hay que verificarlos contra los docs reales** en
[https://api-docs.botmaker.com/](https://api-docs.botmaker.com/).

Para inspeccionar lo que devuelve un endpoint sin tocar el código:

```
https://botmaker-edesal-proxy.tu-cuenta.workers.dev?action=raw&path=/api/v1.0/sessions/active
```

Reemplazar `path` por el que figure en docs. El worker devuelve la respuesta cruda
(en JSON) para que veamos los campos reales y los mapeemos a `whatsapp/webchat/callcenter`.

## 4. Restringir CORS a producción (recomendado)

Dentro de [`worker/botmaker-proxy.js`](worker/botmaker-proxy.js), cambiar:

```js
const ALLOW_ORIGIN = '*';
```

por:

```js
const ALLOW_ORIGIN = 'https://cristianferrero.github.io';
```

Y redeploy. Así sólo tu sitio puede pedirle datos.

## 5. Polling

El dashboard pide al worker:
- `?action=snapshot` cada **15 s** → canales activos
- `?action=snapshot` cada **60 s** → total mensual (no cambia rápido)

Cloudflare Workers tiene 100k requests/día gratis — sobra de lejos para esto.
