# News Monitor

Código del proyecto **News Monitor**. La ficha de seguimiento está en
`../README.md` (no la confundas con esta).

Market Intelligence personal: recoge datos macro y noticias, **filtra, prioriza,
contextualiza y explica**, y manda una alerta a Telegram. No es un agregador.

> **Este repositorio es público.** Ningún dato personal vive aquí: ni watchlist,
> ni umbrales propios, ni cifras de cartera. Todo eso va a la base de datos o a
> los secretos de GitHub. Un secreto commiteado una vez sigue publicado aunque
> se borre después.

## Estado

Bloque 1 (días 1-2) completo y con persistencia. El slice vertical funciona de
punta a punta:

```
FRED  →  normalización  →  filtro por reglas  →  dedupe  →  scoring (Haiku)
                                                              ↓
                    Telegram  ←  formato de alerta  ←  análisis (Opus, solo si importa)
                                                              ↓
                                                        Neon Postgres
```

Falta el dashboard, y las fuentes son de momento solo FRED.

## Stack

Node 22 + TypeScript en ESM, sin transpilar (`tsx`). Tres dependencias de
runtime —`zod`, el SDK de Anthropic y el driver de Neon— y ninguna más; el HTTP
es `fetch` nativo con timeout y reintentos propios.

**Todo va por HTTPS, incluidas las migraciones.** El puerto 5432 de Postgres está
bloqueado en algunas redes (la de casa, por ejemplo), así que el migrador usa el
mismo driver HTTP que la aplicación en vez del cliente TCP. A cambio, el endpoint
HTTP admite una sentencia por llamada y el archivo `.sql` se trocea en
`src/lib/sql.ts` — con un recorrido que respeta cadenas, identificadores
entrecomillados, cuerpos `$$` y comentarios, porque un `split(";")` pelado se
rompe en cuanto una migración lleve un punto y coma dentro de un texto.

| Módulo | Qué hace |
|---|---|
| `src/sources/fred.ts` | Lee FRED y normaliza. Calcula la variación interanual a partir de observaciones reales |
| `src/schema/event.ts` | El contrato: `NormalizedEvent`. Toda fuente futura normaliza aquí |
| `src/pipeline/rules.ts` | Paso 1 de la cascada: filtro gratis, sin LLM |
| `src/pipeline/seen.ts` | Idempotencia y registro de lo enviado. Interfaz común: archivo local o Neon |
| `src/db/neon.ts` | Implementación en Postgres de esa interfaz |
| `src/lib/sql.ts` | Trocea un archivo SQL en sentencias respetando cadenas y comentarios |
| `src/ai/cascade.ts` | Pasos 3 y 4: scoring barato y análisis profundo, con salida estructurada |
| `src/lib/fabrication.ts` | Control anti-fabricación: toda cifra en prosa existe en los datos |
| `src/notify/telegram.ts` | Formato de la alerta (función pura) y envío |

## Uso

```bash
npm install
cp .env.example .env      # y rellena las claves
npm run db:migrate        # crea el esquema en Neon
npm start                 # ciclo completo
npm start -- --dry        # todo menos enviar a Telegram
npm start -- --force      # ignora el registro de vistos
npm run check             # typecheck + tests
```

Sin credenciales el programa no falla a ciegas: dice **qué** falta, **para qué**
sirve y **dónde** conseguirlo, y sale con código 1.

## Producción

`.github/workflows/monitor.yml` ejecuta el ciclo **cada 15 minutos**. Ese
intervalo solo es posible porque el repositorio es público: en uno privado, las
2.880 ejecuciones al mes no caben en los 2.000 minutos del free tier.

Dos cosas que el cron de GitHub hace y conviene no olvidar:

- **Va en UTC y llega tarde**, entre 5 y 15 minutos. Esto no sirve para alertas
  al segundo y no lo pretende.
- **Se desactiva solo** tras 60 días sin actividad en el repositorio, y sin
  avisar. Por eso existe `keepalive.yml`, que hace un commit al mes.

Si el ciclo falla, el propio workflow manda un aviso a Telegram con el enlace de
la ejecución: un monitor que se cae en silencio es peor que no tener monitor.

Los secretos que hay que dar de alta en el repositorio: `FRED_API_KEY`,
`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` y `DATABASE_URL`.

## Decisiones que condicionan el código

- **La sorpresa declara siempre contra qué se compara.** FRED no publica
  consenso de analistas y no hay fuente gratuita fiable, así que la alerta dice
  `vs consenso`, `vs anterior` o `vs media 3m`. Un porcentaje de sorpresa sin
  base declarada miente por omisión.
- **Un hueco antes que un cero de relleno.** Si un dato no existe, no se imprime.
- **El análisis caro solo corre por encima del umbral** (`DEEP_ANALYSIS_THRESHOLD`,
  7 por defecto). Ahí está el ahorro de la cascada.
- **El estado vive en Neon, no en disco.** El job de Actions arranca con el disco
  vacío: sin base de datos remota, el cron no recuerda nada y repite la alerta
  cada quince minutos. El archivo local queda solo para desarrollo.
- **Las migraciones son idempotentes y se aplican enteras cada vez.** No hay
  registro de lo aplicado; para un esquema de este tamaño no hace falta más.
- **Una cifra inventada degrada la alerta, no tumba el ciclo.** Si el modelo cita
  un número que no está en los datos, se reintenta una vez y, si insiste, se envía
  el resumen corto del scoring. Callarse justo cuando hay noticia es el peor
  resultado posible.
