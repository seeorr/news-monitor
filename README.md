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

npm run brief                  # compone el resumen y lo guarda en Neon
npm run brief -- --send        # además lo entrega a los destinos configurados
npm run brief -- --dry --preview   # dos vistas locales, sin escribir ni enviar

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

El monitor pide dos disparos por hora, en los minutos :07 y :37, y ejecuta
**un ciclo corto por disparo**. GitHub puede retrasarlos o descartarlos. No hay
un runner reservado durante cinco horas: ese experimento se revirtió.

Un hueco **puede perder noticias**: los feeds tienen una ventana limitada y el
filtro descarta titulares y documentos de más de 72 horas. El índice único de
alertas evita filas duplicadas en Neon, pero no deshace un mensaje ya enviado:
si Telegram acepta y la escritura posterior falla, el ciclo puede reenviarlo.
La concurrencia del workflow reduce solapamientos; no es una garantía de entrega
exactamente una vez.

Los horarios son UTC. La agenda tiene tres intentos matinales y el latido dos
fechas al mes, días 1 y 15. El aviso de fallo existente enlaza la ejecución de
Actions. Para una vuelta manual: `gh workflow run monitor.yml`.

Secretos: `FRED_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID` y `DATABASE_URL`. `SEC_USER_AGENT` es el contacto exigido
por la SEC. `TELEGRAM_GROUP_CHAT_ID` es **opcional** y activa el grupo
compartido. La watchlist vive en Neon; las variables de watchlist son respaldo.

### Régimen y resumen matinal

`npm run regimen -- --dry --preview` consulta cuatro series de FRED y deja
una vista privada en `.cache/regimen.txt`. Sin `--dry`, persiste una fotografía
diaria en `market_regimes`. No usa modelos ni envía mensajes.

La clasificación descriptiva `riesgo-us-v1` exige unanimidad de VIX, tendencia
del S&P 500 frente a su media de 200 sesiones y spread HY. VIX <20 y spread <4%
son favorables; VIX >=30 y spread >=6% son adversos; los intervalos son mixtos.
La tendencia vota según el cierre esté por encima o debajo de la media.
Sin las tres señales válidas se declara `insufficient_data`. El dólar amplio
de la Fed es contexto: no es DXY. La liquidez sigue sin cubrirse. Estos umbrales
son una heurística explícita, sin validación predictiva ni recomendaciones de
operación. Cada fotografía guarda las observaciones usadas, las fechas y las
reglas para recalcularla.

`npm run brief -- --dry --preview` compone el resumen: eventos ya puntuados de
las últimas 24 horas, agenda y régimen. Deja **dos** vistas locales,
`.cache/morning-brief.txt`, que es literalmente lo que se va a publicar en los
dos destinos. Sin `--dry` se guarda en `daily_briefs`; con `--send` se
entrega. El workflow `brief.yml` corre `npm run brief -- --send`, así que el
resumen **se envía siempre**, no sólo se guarda. Sus horarios siguen dependiendo
de GitHub y el segundo disparo del día encuentra el resumen ya entregado y sale
`blocked`, que no es un fallo. Aplicar `npm run db:migrate` antes de activarlo.

### El grupo compartido

`TELEGRAM_GROUP_CHAT_ID` es opcional y añade un **segundo destino** para
compartir noticias con otras personas. Sin esa variable no hay grupo y todo se
comporta igual que antes: ni fila de más en `daily_briefs`, ni envío de más, ni
fallo del job.

**El grupo recibe exactamente lo mismo que el chat privado**, sin filtrar. Eso
incluye lo que delata la cartera: un `ACME +4,2 % en la sesión` o un
`ACME · 8-K` solo existen porque ACME está en la watchlist, porque los precios y
los documentos solo se consultan de lo que se vigila.

Es una decisión explícita de Alberto, tomada con la fuga delante: **el sistema
revela qué empresas sigue, no cuánto tiene en cada una**, y esa asimetría le
vale. Está escrito aquí y en `src/main.ts` porque es justo el tipo de cosa que
dentro de seis meses parece un descuido, y no lo es.

Si algún día deja de valer, el sitio donde filtrar es `copiarAlGrupo()` en
`src/main.ts`, y el criterio defendible sería *"solo lo que el monitor habría
marcado con la watchlist vacía"* —evaluable con `applyRules(evento, {})` más la
exclusión de `yahoo` y `sec-edgar`—, que es determinista y se audita mirando el
evento. No está implementado: no hay ningún interruptor apagado esperando.

Para activarlo:

1. Crear el grupo en Telegram y añadir el bot como miembro.
2. Escribir `/start@<usuario_del_bot>` en el grupo. Con el modo privacidad
   activado —el de por defecto— un mensaje normal **no** llega al bot y no
   aparecerá en `getUpdates`; un comando dirigido a él, sí.
3. Abrir `https://api.telegram.org/bot<TOKEN>/getUpdates` y coger el `chat.id`:
   es un número **negativo** (`-100…`), no un `@nombre`.
4. Cargarlo como `TELEGRAM_GROUP_CHAT_ID` en `.env` (local) y en los secretos
   del repositorio (Actions). Nunca en el código: el repositorio es público.

Cada destino lleva su propia fila y su propio estado de envío en `daily_briefs`
—la clave primaria es `(brief_date, destination)`—, así que un resumen entregado
en privado no se da por entregado en el grupo, y un `sending` bloqueado en uno
no bloquea el otro. La máquina de estados no cambia: `sending` no caduca por
tiempo y un acuse perdido deja la fila bloqueada, porque Telegram no ofrece
idempotencia y un resumen duplicado en un grupo con gente es peor que uno que no
sale. En las alertas del ciclo la copia al grupo va **después** de registrar el
envío privado y ningún fallo suyo tumba el ciclo: se anota en el log
(`GROUP_SENT`, `GROUP_SKIPPED`, `GROUP_REJECTED`, `GROUP_FAILED`) y se sigue.

En PowerShell, usar `npm.cmd` en estos comandos para conservar los argumentos
que siguen a `--`. Un resumen vacío no demuestra que el mercado esté tranquilo:
puede significar que el monitor no ha ingerido o puntuado eventos.

Los datos de ICE BofA son para uso interno y no se publican en logs, fixtures ni
repositorios. Consultar [las condiciones de la serie](https://fred.stlouisfed.org/series/BAMLH0A0HYM2).
El código público sólo contiene reglas y ejemplos sintéticos. Las vistas locales
se guardan en `.cache/`, que está excluida de git, y se rechazan en Actions.

### El dashboard, si se despliega

Necesita `DATABASE_URL` y `FRED_API_KEY`, siempre del lado servidor.
**La protección estándar de Vercel no protege el dominio de producción**;
activar Vercel Authentication en Hobby no basta para publicar una cartera allí.
Antes de exponerlo hay que implementar acceso en la aplicación o comprobar una
protección que cubra todas sus URLs, incluidas acciones de escritura.
[Documentación oficial de protección](https://vercel.com/academy/optimize-your-vercel-account/deployment-protection).

## Decisiones que condicionan el código

- **La sorpresa declara siempre contra qué se compara.** FRED no publica
  consenso de analistas y no hay fuente gratuita fiable, así que la alerta dice
  `vs consenso`, `vs anterior` o `vs media 3m`. Un porcentaje de sorpresa sin
  base declarada miente por omisión.
- **Un hueco antes que un cero de relleno.** Si un dato no existe, no se imprime.
- **El análisis caro solo corre por encima del umbral** (`DEEP_ANALYSIS_THRESHOLD`,
  7 por defecto). Ahí está el ahorro de la cascada.
- **Y cuando corre, se guarda estructurado, no solo en prosa.** Hasta el 9 de
  septiembre la salida del paso 4 se formateaba y se tiraba: lo único que llegaba
  a la base era el texto ya montado dentro de `alerts.body`. Se pagaba el modelo
  caro por un análisis que la base no podía consultar. Ahora va entera a
  `alerts.analysis`, un `jsonb`, y `body` se queda con el papel que de verdad
  tiene: ser la copia literal de lo que salió a Telegram. Una columna y no tres
  tablas —los activos afectados se consultan con `@>` sobre el `jsonb`— porque
  una tabla que hoy no consulta nadie es esquema muerto, y el `jsonb` guarda lo
  suficiente para rellenarla el día que se gane su sitio.
- **El estado vive en Neon, no en disco.** El job de Actions arranca con el disco
  vacío: sin base de datos remota, el cron no recuerda nada y repite la alerta
  en cada vuelta. El archivo local queda solo para desarrollo.
- **Las migraciones son idempotentes y se aplican enteras cada vez.** No hay
  registro de lo aplicado; para un esquema de este tamaño no hace falta más.
- **Una cifra inventada degrada la alerta, no tumba el ciclo.** Si el modelo cita
  un número que no está en los datos, se reintenta una vez y, si insiste, se envía
  el resumen corto del scoring. Callarse justo cuando hay noticia es el peor
  resultado posible.
- **Una fuente caída no tumba el ciclo, y un evento fallido no tumba a los que
  quedan.** Se recogen todas las fuentes, se dice cuál falló y se sigue. El
  siguiente evento puede ser el que importaba.
- **Hay techo de llamadas al modelo por ciclo.** El ciclo solicita una ejecución cada 30 minutos y
  un feed suelta treinta elementos el primer día. Se atiende lo más reciente y el
  resto espera a la vuelta siguiente, que llega en media hora.
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
- **El grupo compartido lo ve todo, sin filtrar.** Decisión de su dueño con el
  riesgo delante: el sistema revela qué empresas sigue, no cuánto tiene en cada
  una. Aun así los dos destinos llevan estado de envío separado, porque entregar
  en uno no dice nada de si se entregó en el otro.
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
