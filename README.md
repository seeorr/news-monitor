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

Bloques 1 a 4 completos. Cuatro fuentes entran por el mismo contrato y el ciclo
procesa N eventos por vuelta:

```
FRED (3 series)  ─┐
feeds RSS/Atom   ─┤
SEC EDGAR        ─┼→ evento normalizado → frescura → reglas → dedupe → agrupacion
precios (Yahoo)  ─┘                                                        │
                                                                           ▼
                                                            scoring (Haiku, con techo)
                                                                           │
                              Telegram ← formato ← analisis (Opus, solo si importa)
                                                                           │
                                                                     Neon Postgres
```

Aparte del ciclo, una vez al dia: la **agenda macro** (`npm run agenda`), que
dice lo que se publica esta semana. No pasa por la cascada porque no hay nada que
interpretar en una lista de fechas.

Y un **dashboard** en Next.js sobre las mismas tablas, en `app/`: `/alerts`,
`/news`, `/watchlist` —la única página que escribe—, Home, `/calendar` y
`/settings`. Su especificación de UI/UX está en
[docs/dashboard-ui-ux.md](docs/dashboard-ui-ux.md), anclada a lo que el sistema
produce de verdad: dice de qué tabla y de qué columna sale cada cosa y, sobre
todo, qué pide el diseño que el backend todavía no genera. `/markets`,
`/earnings` y `/regime` no existen ni salen en la navegación, porque sus datos
tampoco.

El dashboard vive en **este mismo paquete** y no en uno aparte: sus páginas leen
`src/db/lectura.ts` y su formulario llama a `src/db/watchlist.ts`. Con dos
paquetes habría que duplicar ese SQL o montar un truco de resolución entre
carpetas, y el SQL de este proyecto está en un sitio.

## Stack

Node 22 + TypeScript en ESM, sin transpilar (`tsx`). El ciclo tiene tres
dependencias de runtime —`zod`, el SDK de Anthropic y el driver de Neon— y
ninguna más; el HTTP es `fetch` nativo con timeout y reintentos propios.

El dashboard añade Next.js, React y Tailwind, y **nada más**: sin librería de
componentes. Los tokens de color, tipografía y espaciado están en
`app/globals.css` como variables CSS, y los primitivos que hacen falta
—desplegable, campo, interruptor, acordeón— son elementos nativos (`select`,
`input`, un `button` con `aria-pressed`, `details`): accesibles de serie y cero
dependencias. El motivo no es solo el peso: una librería trae su propia capa de
tokens semánticos, y dos sistemas de color en la misma app es exactamente cómo se
rompe la regla de que verde significa siempre lo mismo.

**Todo va por HTTPS, incluidas las migraciones.** El puerto 5432 de Postgres está
bloqueado en algunas redes (la de casa, por ejemplo), así que el migrador usa el
mismo driver HTTP que la aplicación en vez del cliente TCP. A cambio, el endpoint
HTTP admite una sentencia por llamada y el archivo `.sql` se trocea en
`src/lib/sql.ts` — con un recorrido que respeta cadenas, identificadores
entrecomillados, cuerpos `$$` y comentarios, porque un `split(";")` pelado se
rompe en cuanto una migración lleve un punto y coma dentro de un texto.

| Módulo | Qué hace |
|---|---|
| `src/schema/event.ts` | El contrato: `NormalizedEvent`. Toda fuente normaliza aquí |
| `src/sources/fred.ts` | Lee FRED y normaliza. Calcula la variación interanual a partir de observaciones reales |
| `src/sources/rss.ts` | Registro de feeds y conversión a eventos. Oficiales (Fed, BCE, SEC) y prensa |
| `src/sources/sec-edgar.ts` | Documentos ante la SEC de la watchlist: resuelve ticker→CIK, filtra por tipo y reconoce los resultados por su apartado |
| `src/sources/mercado.ts` | Precios de Yahoo. Solo es evento la sesion que se sale del umbral de ese valor |
| `src/sources/calendario.ts` | Agenda macro desde FRED: que se publica y cuando |
| `src/db/watchlist.ts` | La watchlist en Neon, con umbral por valor. Alta, baja y edición por columna |
| `src/db/lectura.ts` | Las consultas de lectura del dashboard. El SQL vive aquí, no en las páginas |
| `src/lib/feed.ts` | Lector de RSS 2.0 y Atom sin dependencias: CDATA, entidades, prefijos |
| `src/pipeline/collect.ts` | Recolecta todas las fuentes y corta por frescura. Una caída no tumba el ciclo |
| `src/pipeline/rules.ts` | Paso 1 de la cascada: filtro gratis, sin LLM. Y la puerta de la alerta |
| `src/pipeline/agrupar.ts` | La misma historia contada por cinco medios es una historia: se funde antes de gastar modelo |
| `src/pipeline/seen.ts` | Idempotencia y registro de lo enviado. Interfaz común: archivo local o Neon |
| `src/db/neon.ts` | Implementación en Postgres de esa interfaz |
| `src/lib/sql.ts` | Trocea un archivo SQL en sentencias respetando cadenas y comentarios |
| `src/ai/cascade.ts` | Pasos 3 y 4: scoring barato y análisis profundo, con salida estructurada |
| `src/lib/fabrication.ts` | Control anti-fabricación: toda cifra en prosa existe en los datos |
| `src/notify/telegram.ts` | Formato de la alerta (función pura) y envío. También escribe la sorpresa que imprime el dashboard |
| `app/` | El dashboard. Páginas de servidor; los dos únicos componentes de cliente son la navegación y el alta de la watchlist |

## Uso

```bash
npm install
cp .env.example .env      # y rellena las claves
npm run db:migrate        # crea el esquema en Neon
npm start                 # ciclo completo
npm start -- --dry        # todo menos enviar a Telegram
npm start -- --force      # ignora el registro de vistos
npm run check             # typecheck + tests

npm run agenda            # agenda macro de la semana a Telegram
npm run agenda -- --dry   # la compone y la enseña, sin enviar

npm run watchlist                     # que se vigila
npm run watchlist -- add NVDA         # añadir (resuelve el CIK si hay SEC_USER_AGENT)
npm run watchlist -- add EUNL --simbolo EUNL.DE --umbral 2
npm run watchlist -- rm NVDA

npm run dashboard         # el dashboard en local, http://localhost:3000
npm run dashboard:build   # build de producción
```

La watchlist también se gestiona desde el dashboard, en `/watchlist`, sin tocar
la terminal: es el mismo `anadir()` / `quitar()` / `actualizar()` por detrás.

Sin credenciales el programa no falla a ciegas: dice **qué** falta, **para qué**
sirve y **dónde** conseguirlo, y sale con código 1.

## Producción

`.github/workflows/monitor.yml` ejecuta el ciclo **cada 15 minutos**, y
`agenda.yml` manda la agenda macro **a las 06:30 UTC de lunes a viernes**. Ese
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

Tres más, opcionales, que **no pueden vivir en el código porque el repositorio es
público**: `SEC_USER_AGENT` (el contacto que la SEC exige; sin él EDGAR responde
403 y la fuente se salta), `SEC_WATCHLIST` y `WATCHLIST` (qué empresas se
vigilan, que es exactamente el dato que dice en qué inviertes).

### El dashboard, si se despliega

**Se despliega con protección de acceso.** Enseña la watchlist, y una URL
adivinable con una cartera dentro es una filtración aunque nadie enlace a ella.
En Vercel: Deployment Protection → Vercel Authentication, incluida en el plan
Hobby.

Necesita `DATABASE_URL` —sin ella no hay nada que leer— y `FRED_API_KEY`, que la
agenda consulta en vivo. Ninguna de las dos es `NEXT_PUBLIC_`, y ninguna consulta
sale del servidor: el driver de Neon es de servidor y el navegador solo manda
formularios.

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
- **Una fuente caída no tumba el ciclo, y un evento fallido no tumba a los que
  quedan.** Se recogen todas las fuentes, se dice cuál falló y se sigue. El
  siguiente evento puede ser el que importaba.
- **Hay techo de llamadas al modelo por ciclo.** El cron corre cada 15 minutos y
  un feed suelta treinta elementos el primer día. Se atiende lo más reciente y el
  resto espera a la vuelta siguiente, que llega en un cuarto de hora.
- **El corte por antigüedad no se aplica a los datos macro.** Un titular de hace
  una semana no es noticia; el IPC de agosto lleva fecha del 1 de agosto y se
  publica a mediados de septiembre. Ahí la novedad la decide el registro de
  vistos, no el calendario.
- **De prensa solo se anuncia lo que llega al umbral.** De una fuente primaria
  basta con que el modelo lo pida. Cuatro avisos de relleno y se deja de mirar el
  teléfono: es la forma real en que un monitor deja de servir.
- **La misma historia contada por cinco medios es una historia.** Se agrupa por
  parecido de titulares —Jaccard sobre palabras, no un modelo— antes de puntuar.
  El umbral (0,6) está calibrado con titulares reales: con 0,5 se fundían "Best
  CD rates" y "Best high-yield savings rates", que son cosas distintas.
- **La agenda descarta lo que aparece a diario.** FRED marca el comunicado del
  FOMC y los tipos del BCE como publicación de todos los días. No son citas: son
  series continuas, y anunciarlas cada mañana vacía la agenda de sentido. Esas
  decisiones ya entran por los feeds de prensa de la Fed y del BCE.
- **La watchlist vive en Neon, no en el entorno.** Dice en qué invierte su dueño,
  y en un repositorio público eso no puede estar ni en el código ni a la vista.
  Además cada valor lleva su propio umbral de movimiento: un 3 % en una utility
  no es lo mismo que un 3 % en una biotecnológica.
- **El dashboard no rellena un hueco con un cero.** Es el mismo principio del
  backend aplicado a la pantalla: la insignia de importancia no se pinta si el
  evento nunca se puntuó, la fila de la watchlist dice "ninguna sesión ha superado
  su umbral" en vez de un 0,0 %, y donde falta el consenso se dice que ninguna
  fuente gratuita lo publica. Un guion mudo parece un descuido; un hueco
  declarado, no.
- **De los resultados nos enteramos por el apartado 2.02 de un 8-K.** Es la vía
  gratuita y oficial: los calendarios de earnings de pago no hacen falta para
  saber que una empresa acaba de presentar cuentas.
