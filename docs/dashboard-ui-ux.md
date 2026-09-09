# Dashboard — especificación de UI/UX

Este documento es el que se le da a Claude Code cuando llegue la fase del
dashboard (días 12-14 del cronograma). Nace de una spec de UI/UX escrita antes
de que existiera el backend, y se ha reescrito **contra lo que el sistema
produce de verdad hoy**: cada página y cada componente dice de qué tabla y de
qué columna sale lo que pinta, y cuando algo no existe, lo dice en vez de
suponerlo.

Esa es la única diferencia relevante con el documento original, y es toda la
diferencia. Una spec de diseño que pide un campo que nadie genera no produce una
página incompleta: produce una página que se rellena con datos inventados, que es
exactamente lo que este proyecto existe para no hacer. Aquí, **un hueco antes que
un cero de relleno** vale igual para la pantalla que para la alerta.

> **Este repositorio es público.** El dashboard enseña la watchlist, que dice en
> qué invierte su dueño. Ese dato vive en Neon y no puede acabar aquí: ni en un
> ejemplo, ni en un fixture, ni en una captura. Los tickers que aparecen en este
> documento (`ACME`, `GLOBX`) son inventados a propósito.

## Referencia externa que falta

La spec original se apoya en un documento llamado `market-intelligence-spec-v2.md`
y cita "la sección 19" (universo de activos de `/markets`) y "la sección 34"
(observabilidad de `/settings`). **Ese documento no está en el vault ni en este
repositorio.** Se ha buscado y no aparece.

Nadie debe construir asumiendo que existe. Donde la spec original delegaba en él,
aquí se dice qué hay en su lugar:

- **Sección 19 (universo de activos)** → no hay tal universo en el código. Lo
  único que se cotiza es la watchlist de Neon, y solo cuando se sale del umbral.
  Ver el hueco G4.
- **Sección 34 (observabilidad)** → no hay tabla de ejecuciones ni registro de
  errores fuera de los logs de GitHub Actions. Ver el hueco G7.

Si el documento aparece, esta sección se revisa. Mientras tanto, lo que manda es
el código.

---

# 0. De dónde salen los datos

Antes de los principios de diseño, el inventario. Todo lo que el dashboard puede
pintar hoy sale de tres tablas de Neon (`neon/migrations/`) y del contrato de
evento normalizado (`src/schema/event.ts`). Nada más. No hay API pública, no hay
caché intermedia y no hay ningún almacén paralelo.

## `events` — un evento normalizado por fila

Es la fila que escribe `mark()` en `src/db/neon.ts`, y la escriben **todos** los
eventos que llegan a la cascada, alerten o no.

| Columna | Tipo | Qué es y qué esperar dentro |
|---|---|---|
| `id` | text PK | Id determinista: `fuente:serie:observacion`. Es lo que hace idempotente la alerta |
| `source` | text | `fred` · `rss` · `sec-edgar` · `yahoo` · `coingecko` (esta última declarada en el enum, **sin implementación**) |
| `source_url` | text null | Enlace al original. Es lo que abre el botón "fuente" de la ficha |
| `kind` | text | `macro_release` · `news` · `filing` · `market_move` · `calendar`. **Es el único "tipo de evento" real que existe** |
| `title` | text | Titular ya compuesto por la fuente. Para un documento es `TICKER · 8-K — resultados` |
| `summary` | text null | Entradilla de la noticia o contenido declarado del documento. Un dato macro no lo tiene |
| `country` | text null | **Un emoji de bandera**, no un código ISO: `🇺🇸`, `🇪🇺`, `🌐`. Y viene del feed, no del contenido |
| `series_id` | text null | Serie de FRED (`CPIAUCSL`), id del feed (`cnbc-markets`), ticker (`ACME`) o `agenda` |
| `observed_at` | text | Fecha del dato. **Texto a propósito y de precisión mixta**: `2026-08-01` para macro, instante ISO para una noticia |
| `retrieved_at` | timestamptz | Cuándo lo vimos nosotros |
| `first_seen_at` | timestamptz | Cuándo entró en la base. **Es la única columna fiable para ordenar cronológicamente todo junto** |
| `actual` | float null | Solo macro y `market_move` (ahí es el % de la sesión) |
| `previous` | float null | Solo macro |
| `consensus` | float null | **Siempre null hoy.** Ninguna fuente lo publica y la decisión sigue abierta |
| `unit` | text null | `%` en macro y en movimientos de precio |
| `surprise_value` / `surprise_basis` | float / text null | Solo macro. La base es `consensus`, `previous` o `mean_3m`, y en la práctica nunca es la primera |
| `stale` | bool | El dato es el último válido conocido, no uno fresco. **La UI debe decirlo, igual que la alerta** |
| `official` | bool | Fuente primaria (Fed, BCE, SEC, FRED). Pasa el filtro por reglas siempre |
| `importance_score` | int 0-10 null | Nota del paso 3, alerte o no. Null = nunca se puntuó |
| `market_impact_score` | int 0-10 null | Ídem |
| `sentiment` | text null | `bullish` · `bearish` · `neutral`. Ídem |
| `one_liner` | text null | La frase del paso 3. **Es el único resumen propio de un evento sin alerta**: el `title` y el `summary` los escribe la fuente |

Índices que ya existen y que conviene respetar al escribir las consultas:
`events_por_serie (series_id, observed_at desc)`,
`events_por_fuente (source, first_seen_at desc)` y
`events_por_importancia (importance_score desc, first_seen_at desc)`, que es el que
sirve al "lo importante" del Home.

## `alerts` — lo que de verdad se envió

Una fila por evento anunciado. `alerts_un_evento` es un índice **único** sobre
`event_id`: no puede haber dos.

| Columna | Tipo | Qué es |
|---|---|---|
| `event_id` | text FK → `events.id` | El join obligatorio de casi todas las pantallas |
| `sent_at` | timestamptz | Cuándo salió a Telegram |
| `importance_score` | int 0-10 | Del paso 3 de la cascada (Haiku) |
| `market_impact_score` | int 0-10 | Ídem |
| `sentiment` | text | `bullish` · `bearish` · `neutral` |
| `deep_analysis` | bool | Si corrió el paso 4 (Opus) o se quedó en el resumen barato |
| `body` | text | **El texto plano de la alerta de Telegram, tal cual** |

Aquí hay dos cosas que condicionan medio dashboard y conviene entender antes de
diseñar nada:

1. ~~**La puntuación solo sobrevive si hubo alerta.**~~ **Ya no** (9 de septiembre,
   hueco G1 cerrado). `mark()` escribe la nota del paso 3 en las cuatro columnas
   de `events` —`importance_score`, `market_impact_score`, `sentiment`,
   `one_liner`—, alerte o no. Para jerarquizar se lee `events`; `alerts` dice qué
   se envió, con qué nota y con qué texto. Lo que sigue a null es lo que nunca se
   puntuó: lo que no pasó el filtro por reglas, y los duplicados de un grupo.
2. **El análisis profundo no se persiste estructurado.** `analyzeEvent()`
   devuelve `why_it_matters`, `catalysts`, `risks`, `affected_assets` y
   `what_to_watch` (`src/ai/cascade.ts`), pero lo único que llega a la base es la
   prosa ya formateada dentro de `alerts.body`. No hay tabla de catalizadores, ni
   de riesgos, ni de activos afectados.

## `watchlist` — qué se vigila

| Columna | Tipo | Qué es |
|---|---|---|
| `ticker` | text PK | En mayúsculas. Lo normaliza `anadir()` |
| `nombre` | text null | Nombre de la empresa, si se resolvió |
| `cik` | text null | Identificador de la SEC, diez dígitos con ceros a la izquierda. Sin él no hay documentos |
| `quote_symbol` | text null | Símbolo de Yahoo cuando no coincide con el ticker |
| `vigilar_filings` | bool, default true | Si se le miran los documentos |
| `vigilar_precio` | bool, default true | Si se le mira el precio |
| `umbral_movimiento` | float, default 3 | % de la sesión a partir del cual es noticia. **Por valor** |
| `anadido_en` | timestamptz | Cuándo se dio de alta |

**Esto es dato personal.** Vive en Neon y solo en Neon. La sección 6 desarrolla
qué significa eso para la app.

## Lo que no está en ninguna tabla

Ni régimen de mercado, ni sector, ni horizonte temporal, ni consenso de
analistas, ni cifras de resultados, ni precios históricos, ni grupos de
watchlist, ni registro de ejecuciones del cron. Nada de eso es un olvido de la
UI: **no existe aguas arriba**. La sección 7 lo desglosa uno a uno.

## Cómo lee el dashboard

`DATABASE_URL` es un secreto y el driver de Neon es de servidor. Toda lectura va
en un Server Component o en un route handler; **ninguna consulta se hace desde el
navegador y `DATABASE_URL` nunca entra en una variable `NEXT_PUBLIC_`.** El
dashboard no es un panel público: enseña una cartera. Si se despliega, se
despliega protegido.

---

# 1. Principios de diseño

Gobiernan cada decisión visual. Ante dos formas de mostrar algo, gana la que
mejor cumpla esto:

1. **El color siempre significa lo mismo en toda la app.** Verde, rojo y ámbar
   son importancia y sentimiento, nunca decoración. Si un tono es "bullish" en
   `/news`, no puede ser otra cosa en `/markets`.
2. **Escaneable antes que legible.** Se debe entender el estado general de una
   página en dos o tres segundos sin leer una frase entera: badges, chips, bordes
   de color, iconos.
3. **Jerarquía es importancia real, no orden cronológico.** Lo importante arriba
   y más grande, no lo reciente. La importancia existe para todo lo que pasó por
   el paso 3 (§0); donde no la haya —lo que ni se puntuó— la jerarquía la dan
   `kind` y `official`, y se dice.
4. **Contexto antes que detalle.** Primero el panorama —totales, resumen—, luego
   el listado.
5. **Denso pero respirable.** Mucha información por pantalla, que esto es una
   terminal y no un blog, pero con separación clara entre bloques.
6. **Un hueco declarado antes que un cero de relleno.** Es el principio del
   backend y aquí manda igual. Un campo que el sistema no genera se enseña como
   ausente y con su motivo —"consenso: ninguna fuente gratuita lo publica"—,
   nunca como un guion mudo y jamás como un valor plausible.

---

# 2. Design tokens

Como variables CSS o config de Tailwind **desde el primer commit del frontend**.
Nunca un color suelto dentro de un componente: en cuanto hay dos, el principio 1
deja de poder cumplirse.

## Colores semánticos

```text
--success   → verde   → bullish, variación positiva, risk-on
--danger    → rojo    → bearish, variación negativa, risk-off, importancia crítica
--warning   → ámbar   → importancia media/alta, neutral con matiz, eventos próximos
--accent    → azul    → interactivo, sentimiento neutral, navegación activa
--muted     → gris    → texto secundario, metadatos, elementos inertes
```

Cada uno con tres variantes como mínimo: `-bg` (fondo suave de badge), `-text`
(texto sobre ese fondo) y `-border`. El tono fuerte nunca es fondo de un bloque
grande: solo acento puntual —borde izquierdo, punto, badge pequeño—.

Hay un sexto estado que la spec original no contemplaba y que este backend sí
produce: **dato obsoleto** (`events.stale`). No es un color nuevo, es `--warning`
en su variante más apagada más el texto "último valor conocido". Un dato viejo
pintado como uno fresco es la clase de mentira que este sistema no se permite.

## Superficies

```text
--surface-page    → fondo general
--surface-card    → tarjetas
--surface-raised  → elementos dentro de una tarjeta (chips, filas)
--border-default  → borde estándar, 1px o menos
```

## Tipografía

```text
Tamaños:      12px metadatos/chips · 13px texto secundario · 15px cuerpo y titulares ·
              16-18px cifras destacadas · 20-22px headers de página
Pesos:        400 en cuerpo, 500 en títulos y cifras. Evitar el 700: pesa
Interlineado: 1,5-1,6 en párrafos de resumen
```

Una cifra siempre en cifras tabulares dentro de tablas y `MetricCard`: los
números de `/calendar` y `/markets` se leen en columna y bailan si no lo son.

**Los números se escriben en español**, con coma decimal, igual que en la alerta
(`es()` en `src/notify/telegram.ts`). Que la misma cifra se lea distinta en el
móvil y en la pantalla sería un fallo de coherencia gratuito.

## Espaciado y forma

```text
Radio:              8px chips/badges · 12px tarjetas
Bordes:             0,5-1px, sutiles. Nunca sombras marcadas
Padding tarjeta:    14-16px
Gap entre tarjetas: 8-10px
```

---

# 3. Componentes reutilizables

Se construyen **antes** que ninguna página: se repiten en `/`, `/news`,
`/calendar`, `/alerts` y `/watchlist`. Cada uno lleva de dónde salen sus datos.

### `ImportanceBadge`

"9/10 critical", "6/10 interesting". Fondo según el rango:

```text
9-10 → --danger-bg  / --danger-text    critical
7-8  → --warning-bg / --warning-text   important
4-6  → --warning-bg suave              interesting
0-3  → --muted-bg   / --muted-text     noise (normalmente ni se muestra)
```

**Datos**: `events.importance_score`, con `alerts.importance_score` como origen
equivalente cuando la consulta ya trae el join. Existe para **todo lo que pasó por
el paso 3**, alerte o no (hueco G1, cerrado). Cuando es null —lo que nunca se
puntuó: lo descartado por el filtro por reglas y los duplicados de un grupo— el
componente **no se pinta**; no se inventa un 5 de relleno ni se enseña un guion sin
explicación. Los cuatro rangos se usan de verdad: con `ALERT_THRESHOLD` en 7, lo
anunciado vive entre 7 y 10 y lo ingerido llena los tramos de abajo.

### `SentimentBadge`

"Bullish" / "Neutral" / "Bearish" → `--success` / `--accent` / `--danger`.

**Datos**: `events.sentiment` —o `alerts.sentiment`, que es el mismo valor—, con
los valores exactos `bullish` · `bearish` · `neutral` (el enum de `Scoring` en
`src/ai/cascade.ts`). Mismas condiciones que el badge de importancia: si es null,
no se pinta.

### `ImpactMeter` (añadido)

`market_impact_score` existe en las dos tablas, es 0-10 y hoy no lo enseña nadie:
la alerta de Telegram solo imprime la importancia. Un medidor pequeño de tres o cuatro
tramos junto al `ImportanceBadge` lo aprovecha sin pedirle nada al backend. Es la
mejora más barata de todo el documento.

### `AssetChip`

Ticker en una píldora, fondo `--surface-raised`, sin color semántico propio.
Click → vista de ese activo.

**Datos**: `events.series_id` cuando `kind` es `filing` o `market_move`, que es
donde de verdad es un ticker. Para `macro_release` es una serie de FRED y para
`news` es el id del feed: **en esos dos casos no es un activo y no se pinta como
chip de activo**. Los "activos afectados" que produce el análisis profundo no
están en la base (hueco G2): hoy solo se pueden leer dentro del texto de
`alerts.body`, y parsear prosa para sacar chips es exactamente el tipo de
adivinanza que aquí no se hace.

### `SourceChip`

Fuente y tiempo relativo. **Datos**: `events.source` más `events.series_id`
—que para una noticia es el feed: `fed-press`, `ecb-press`, `sec-press`,
`cnbc-markets`, `yahoo-finance`— y `events.first_seen_at` para el "hace 3 h".
Si `events.official` es true, un punto o un borde lo distingue: la diferencia
entre fuente primaria y prensa gobierna medio pipeline y merece verse.

### `NewsCard`

Orden fijo:

```text
Fila 1: ImportanceBadge + SentimentBadge + ImpactMeter + SourceChip (a la derecha)
Fila 2: Titular — events.title, 15px medium
Fila 3: Resumen — events.summary, 13px, máximo 2 líneas, truncado
Fila 4: AssetChip cuando kind es filing o market_move; si no, nada
```

Click → ficha de detalle (panel lateral o acordeón, no navegación completa).

Dos avisos: `events.summary` es **null** en los datos macro, y viene ya recortado
a 600 caracteres desde `src/sources/rss.ts`, así que la tarjeta trunca sobre algo
ya truncado. Y si el evento está `stale`, la tarjeta lo dice en la fila 1.

### `MetricCard`

Etiqueta pequeña arriba (muted), valor grande abajo (medium), color según la
variación, sin decimales de adorno.

**Datos**: hoy solo es honesto para las tres series de FRED que se ingieren
—`CPIAUCSL`, `UNRATE` y `DGS10`, en `src/sources/fred.ts`—, leyendo la última fila
de `events` por `series_id`. Índices, DXY, oro, petróleo y crypto **no se
ingieren**: leer el hueco G4 antes de diseñar un market snapshot de 2x2.

### `WatchlistRow`

Ticker a la izquierda (medium), variación a la derecha con color semántico. Sin
bordes internos, separador de 0,5px entre filas.

**Datos**: `watchlist.ticker` y `watchlist.nombre`. **La variación no está**: los
precios de Yahoo se piden en cada ciclo pero solo se persisten cuando superan el
umbral del valor (`toEvent()` devuelve null en caso contrario, en
`src/sources/mercado.ts`). Así que la columna derecha no puede ser "% de hoy". Dos
salidas honestas, en orden de preferencia:

1. **Enseñar lo que sí hay**: `watchlist.umbral_movimiento`, si se vigilan sus
   documentos y su precio, y la fecha del último movimiento que sí fue evento
   (`max(events.observed_at)` con `series_id = ticker` y `kind = 'market_move'`).
   Es información real y suficiente para una pantalla de gestión.
2. Cotizar en vivo desde el servidor con `fetchCotizacion()`, que ya existe.
   Cuesta una llamada a Yahoo por ticker y por carga de página, y Yahoo no tiene
   SLA. Si se hace, con caché de unos minutos y con el estado "sin datos" pintado
   de verdad cuando falle, no en blanco.

### `CalendarEventRow`

Fecha (muted, ancho fijo) + borde izquierdo de color por importancia + nombre del
evento. Mismo código de color que `ImportanceBadge`, pero **solo como acento**: de
fondo, una tabla larga se vuelve ilegible.

**Datos**: ver `/calendar`. La agenda se guarda como un único evento, no como una
fila por cita, y no tiene importancia asignada. El borde de color, hoy, no tiene
de dónde salir.

### `RegimeBanner`

Punto de color + etiqueta (Risk-on / Neutral / Risk-off) + confianza + drivers.

**No hay datos.** El régimen de mercado no existe en el código: ni tabla, ni
cálculo, ni ingesta de sus componentes. Ver el hueco G3. **No se construye este
componente en la primera versión** y el layout global no reserva su franja: un
banner con datos falsos en la cabecera de todas las páginas contamina la app
entera, que es justo lo contrario de lo que hace un banner de contexto.

### `EmptyState` (añadido, y no es decorativo)

Un componente de vacío que dice **por qué** está vacío y qué falta para que no lo
esté. Es el equivalente en pantalla de `describeMissing()` en `src/config.ts`, que
ya hace esto mismo con las credenciales: dice qué falta, para qué sirve y dónde
conseguirlo.

Casos reales que se van a dar desde el primer día: watchlist vacía, ningún
documento porque falta `SEC_USER_AGENT`, cero movimientos de precio porque nadie
superó su umbral, agenda sin citas en la ventana. Ninguno es un error, y ninguno
se resuelve con un spinner eterno ni con una ilustración simpática.

---

# 4. Layout global

```text
Barra superior (fija):
  Nombre del sistema (izquierda)
  Navegación: Home · News · Calendar · Watchlist · Alerts (centro)
  Icono de Settings (derecha)

Cuerpo:
  Desktop: 2 columnas — contenido principal (más ancho) + sidebar contextual
  Estrecho: 1 columna, el sidebar baja debajo del contenido. Nunca desaparece
```

Dos diferencias con el layout original, y su motivo:

- **No hay franja de `RegimeBanner`** bajo la barra. No hay régimen que mostrar
  (hueco G3). Cuando lo haya, se añade sin tocar el resto.
- **`/markets`, `/earnings` y `/regime` no entran en la navegación de la primera
  versión.** Un enlace a una página que no puede tener contenido es peor que no
  tenerlo: promete un dato que el sistema no produce. Se añaden cuando el backend
  los produzca (huecos G3, G4 y G5).

---

# 5. Página por página

Cada página lleva su origen de datos y qué se degrada. El orden es el de
construcción recomendado, que **no** es el de la spec original: se empieza por lo
que tiene datos completos.

## `/alerts` — histórico de alertas

Es la página mejor servida del sistema y por eso va primero: `alerts` tiene todo
lo que necesita y ninguna columna se queda a null.

```text
Lista cronológica descendente de NewsCard con indicador "Enviada" + hora
Filtros: importancia mínima (0-10) y rango de fechas
Distintivo "análisis profundo" cuando alerts.deep_analysis es true
Click → panel con el texto íntegro de alerts.body
```

**Datos**: `alerts` con join a `events` por `event_id`. Orden por `sent_at desc`
(hay índice: `alerts_recientes`). Filtros sobre `importance_score` y `sent_at`.

`alerts.body` es texto plano formateado para Telegram, con emojis y saltos de
línea. En el panel de detalle se renderiza **tal cual, en un bloque preformateado
y monoespaciado**, sin intentar reconstruir sus secciones con expresiones
regulares. Es una degradación consciente y se nota poco; parsearlo se rompería en
silencio la primera vez que cambie `formatAlert()`.

## `/news` — todo lo ingerido

```text
Fila de filtros como chips y desplegables, nunca un formulario vertical
Lista de NewsCard a ancho completo, una columna, sin sidebar:
  esta página es para profundizar, no para tener una visión general
Click → acordeón en línea o panel lateral con el detalle
```

**Filtros, uno a uno, con lo que hay detrás:**

| Filtro que pide la spec | Estado | De dónde sale |
|---|---|---|
| Tipo de evento | **existe** | `events.kind`: macro / noticia / documento / movimiento / agenda |
| Fuente | **existe** | `events.source` más `events.series_id` (el feed concreto) |
| Solo fuentes oficiales | **existe** | `events.official` — no estaba en la spec y separa señal de ruido mejor que ningún otro |
| Fecha | **existe, con cuidado** | Filtrar por `first_seen_at` (timestamptz), no por `observed_at`, que es texto de precisión mixta |
| Importancia | **existe** | `events.importance_score`, sobre todo lo puntuado (G1 cerrado). Null en lo que nunca pasó por el paso 3 |
| Sentimiento | **existe** | `events.sentiment`, misma condición |
| Activo | **parcial** | `events.series_id` sirve para documentos y movimientos; una noticia no dice a qué activo afecta |
| País | **degradado** | `events.country` es un emoji del feed, no del contenido: `🇺🇸`, `🇪🇺`, `🌐`. Vale como chip visual, **no como faceta seria** |
| Sector | **no existe** | Hueco G6 |
| Horizonte | **no existe** | Hueco G6 |

La fila de filtros **solo enseña los que funcionan**. Un desplegable de sectores
siempre vacío es peor que su ausencia: enseña que el sistema tiene un agujero
justo donde promete precisión.

**Ficha de detalle**: `events.title`, `summary`, `source_url`, la línea de cifras
(`actual`, `previous`, `consensus`, `unit`, `surprise_value`, `surprise_basis`) y,
si hay alerta, `alerts.body`. La spec pedía enseñar aquí "AI analysis completo,
catalysts, risks" como campos separados: **no se puede** (hueco G2). Van dentro de
la prosa de `body` o no van.

La línea de cifras sigue la regla de `formatAlert()`: solo aparece lo que existe.
Y la sorpresa **siempre declara su base** —"vs anterior", "vs media 3m"—, porque
un porcentaje de sorpresa sin base miente por omisión. Esa etiqueta no es opcional
en la UI.

## `/` (Home)

```text
Grid de 2 columnas, proporción aproximada 1,7 : 1

  Columna principal:
    Header "Lo importante" + chips de filtro (importancia, tipo de evento, fuente)
    Lista de NewsCard: las últimas alertas por importancia y recencia, de 5 a 10

  Sidebar:
    Bloque "Macro"     → MetricCard de las tres series de FRED que se ingieren
    Bloque "Watchlist" → WatchlistRow apiladas + botón "+ Añadir ticker"
    Bloque "Agenda"    → próximas citas de la ventana
```

**Datos**: la columna principal sale de `events` ordenada por `importance_score
desc, first_seen_at desc` —con `importance_score is not null`, que es lo que usa el
índice `events_por_importancia`— y con techo. El join con `alerts` sirve para
marcar lo que además se envió y para abrir su `body`, no para jerarquizar. El bloque macro, la última fila
de `events` por cada `series_id` de `SERIES`. El de agenda, ver `/calendar`.

Dos cambios respecto a la spec original: **no hay `RegimeBanner`** arriba (hueco
G3) y el snapshot de mercado no es un 2x2 de Nasdaq / S&P / US10Y / BTC, porque de
esos cuatro **solo se ingiere el bono a 10 años** (`DGS10`). Se enseñan las tres
series que existen y ya. El día que haya un job de precios de índices (hueco G4),
este bloque crece sin rediseñarse.

El botón de añadir ticker está **también en el sidebar del Home**, no solo en
`/watchlist`. Es la acción más frecuente de la app y esconderla a dos clics es
justo lo que la sección 6 no quiere.

## `/watchlist`

Es, junto con `/settings`, la única página que **escribe**. Su especificación está
entera en la sección 6, porque el flujo de añadir un ticker es un requisito propio
y no un detalle de esta página.

```text
Cabecera: contador de valores + botón "+ Añadir ticker" (siempre visible)
Lista o grid de tarjetas, una por valor:
  ticker + nombre · CIK resuelto o no · símbolo de Yahoo si difiere
  dos interruptores: vigilar documentos / vigilar precio
  umbral de movimiento, editable en línea
  último movimiento que llegó a ser evento, si lo hubo
Estado vacío que explica qué implica estar vacío (ver sección 6)
```

Los **grupos** que pedía la spec original (IA, Tech, Crypto) y el reordenar
arrastrando **no existen en la tabla**: no hay columna `grupo` ni `orden`. Es una
migración de una línea, pero es backend. Ver el hueco G8. Mientras tanto, orden
alfabético por `ticker`, que es como lo devuelve `leerWatchlist()`.

## `/calendar`

```text
Lista agrupada por día. Solo aparecen los días con algo:
  una lista con cinco "nada previsto" se deja de leer a la tercera vez
Cada fila: fecha + país + nombre de la publicación
Selector: "Hoy" / "Esta semana" / "Próximos 7 días"
```

**Datos, y aquí hay una trampa**: la agenda **no está normalizada por cita**. Se
guarda como **un solo evento** por día de envío —`agendaEvent()` en
`src/sources/calendario.ts`—, con `kind = 'calendar'`, `series_id = 'agenda'` e id
`fred:agenda:AAAA-MM-DD`, y todas las citas concatenadas dentro de `summary` con
el formato `2026-09-11: IPC de Estados Unidos · 2026-09-12: PIB`.

Dos formas de construir la página, y solo una es buena:

- **Recomendada**: llamar a `fetchAgenda()` desde el servidor de Next.js. Es la
  misma función que usa `npm run agenda`, devuelve `Cita[]` ya limpio y con la
  regla de descarte de las publicaciones casi diarias aplicada. Requiere
  `FRED_API_KEY` en el entorno del dashboard y un timeout de 45 s, que es lo que
  la ventana de dos semanas necesita.
- Desaconsejada: partir el `summary` por ` · ` y por `: `. Funciona hasta que un
  título de publicación lleve dos puntos.

Lo que **no se puede pintar** en esta tabla, y por qué:

- **Hora**: FRED publica la fecha, no la hora. El propio mensaje de la agenda lo
  dice en voz alta. La columna no se pone.
- **Previous / Consensus / Actual / Surprise por cita**: la agenda son fechas
  futuras; no hay cifras que asociarles. Y el consenso no existe en ningún sitio
  (hueco G5). Como mucho, cuando una publicación **ya ha salido** y coincide con
  una de las tres series de FRED que se ingieren, se puede cruzar por `series_id`
  y enseñar su `actual`, su `previous` y su sorpresa. Son tres publicaciones de
  las ocho de `RELEASES`.
- **"Market impact" con `SentimentBadge`**: nadie puntúa una cita futura. La
  agenda no pasa por la cascada, a propósito: no hay nada que interpretar en una
  lista de fechas.
- **Importancia como borde de color**: tampoco existe. Si se quiere jerarquía
  visual, que salga de `RELEASES` —el IPC y el informe de empleo pesan más que
  JOLTS— y que sea una constante del frontend declarada como tal, no un campo
  fingido.

El país sí está: `Cita.country`, que es el emoji de `RELEASES`.

## `/markets`

**No se construye en la primera versión.** No hay de qué: no existe tabla de
precios, no se guardan cotizaciones salvo las que superan un umbral, y el universo
de activos de la spec —índices, yields, DXY, oro, petróleo, crypto— no se ingiere.
Ver el hueco G4.

Cuando exista el job de precios, esta es la especificación: grid de `MetricCard`
más completo que el del Home, y click en cualquiera → gráfico de línea simple del
histórico (`fetchSerie()` ya devuelve la serie diaria de un año) más las noticias
relacionadas filtradas por `series_id`. **Nada de velas ni de indicadores
superpuestos**: una línea basta y el resto es sprint que no hay.

## `/earnings`

**No se construye.** El sistema sabe *que* una empresa ha presentado resultados
—por el apartado 2.02 de un 8-K, que es la vía gratuita y oficial— pero no sabe
*qué* ha presentado: no hay ingresos, ni beneficio por acción, ni consenso, ni
guidance, ni métricas propias. Ver el hueco G5, que es el más caro de todos.

Lo que sí se puede hacer sin backend nuevo, y es honesto: una **vista filtrada de
`/news`** con `source = 'sec-edgar'` y etiqueta "resultados", que enseñe qué
empresa ha presentado, cuándo y con enlace al documento. Eso es real. Una
`EarningsCard` con huecos donde van las cifras es una promesa incumplida en
pantalla.

## `/regime`

**No se construye.** Ver el hueco G3.

## `/settings`

```text
Pestañas o acordeón, no un scroll infinito:

  Watchlist   → gestión completa de tickers (sección 6). Escribe en Neon
  Alertas     → umbrales y hora del brief. HOY SOLO LECTURA (ver abajo)
  Fuentes     → activar y desactivar feeds. HOY SOLO LECTURA
  El sistema  → estado de la configuración y de la ingesta
```

La única pestaña que puede **escribir** es la de watchlist, y escribe en la tabla
`watchlist`. Las otras dos no, y el motivo importa:

`ALERT_THRESHOLD`, `DEEP_ANALYSIS_THRESHOLD`, `RSS_FEEDS`, `MAX_ITEM_AGE_HOURS`,
`MAX_SCORING_PER_CYCLE`, `GROUP_THRESHOLD` y compañía se leen de variables de
entorno en `loadConfig()`, y en producción esas variables son **secretos de GitHub
que el workflow inyecta al arrancar el job**. Un formulario del dashboard no puede
cambiarlas: no comparten proceso, ni máquina, ni ciclo de vida. Cambiar esto de
verdad exige una tabla de ajustes en Neon que `loadConfig()` lea, y eso es backend
(hueco G7).

Así que la pestaña de alertas y la de fuentes **enseñan la configuración vigente
en modo lectura**, con una línea que diga dónde se cambia: en los secretos del
repositorio. Es útil —hoy no hay ningún sitio donde consultarla— y no miente. Un
interruptor que no apaga nada sí mentiría.

**"El sistema"**: qué credenciales faltan y para qué sirve cada una es información
que `missingVars()` y `describeMissing()` ya producen y que se puede reutilizar
tal cual desde el servidor. Lo que **no** existe es el registro de ejecuciones:
"última ingesta correcta", "últimos errores", "eventos por ciclo". Eso solo vive en
los logs de GitHub Actions. Como aproximación honesta se puede enseñar
`max(first_seen_at)` de `events` —"el último evento entró hace 12 minutos", que es
una prueba real de que el cron respira— y el conteo por fuente de las últimas 24
horas, aprovechando el índice `events_por_fuente`. Con esa etiqueta y no con otra:
es un indicio de vida, no un registro de ejecuciones.

---

# 6. Añadir un valor a la watchlist desde la app

Este es un requisito propio, no un detalle de `/watchlist`. **Debe poder añadirse
una acción escribiendo su ticker, desde la interfaz, sin tocar la terminal.**

Hoy la watchlist solo se gestiona por CLI. Eso es una fricción real: cada cambio
obliga a abrir una consola en el ordenador donde está el `.env`, lo que en la
práctica significa que la lista no se toca. Y la lista es lo que decide a quién se
le miran los documentos y a quién el precio: si no se mantiene, dos de las cuatro
fuentes se quedan sin nadie a quien vigilar.

## Cómo funciona hoy, exactamente

`src/watchlist.ts` es la CLI y `src/db/watchlist.ts` el acceso a la tabla:

```bash
npm run watchlist                      # lista, ordenada por ticker
npm run watchlist -- add ACME          # añade
npm run watchlist -- add GLOBX --simbolo GLOBX.DE --umbral 2 --nombre "Globex ETF"
npm run watchlist -- rm ACME           # quita
```

Lo que hace `add`, paso a paso:

1. **Exige `DATABASE_URL`.** Sin base de datos no hay watchlist que gestionar: no
   hay respaldo en fichero.
2. **Pasa el ticker a mayúsculas.**
3. **Resuelve el CIK contra la SEC** si hay `SEC_USER_AGENT`, con
   `resolveTickers()`, que descarga `company_tickers.json` y lo cachea en memoria.
   Si el ticker no aparece —un ETF europeo no está en EDGAR—, **no es un error**:
   se añade sin CIK y se dice. Sin `SEC_USER_AGENT`, tampoco es un error: se añade
   sin CIK y se dice.
4. **Inserta con `on conflict (ticker) do update`**, que completa la fila en vez de
   ignorarla: volver a añadir un ticker que ya estaba sirve para rellenarle el CIK
   o el nombre que faltaban.

`quitar()` hace un `delete ... returning ticker` y devuelve si borró algo, para
poder distinguir "quitado" de "no estaba".

**Una trampa del `on conflict` que ya no existe, y conviene saber por qué**: hasta
el 8 de septiembre `umbral_movimiento = excluded.umbral_movimiento` iba **sin
`coalesce`**, así que un alta repetida sin umbral explícito devolvía el valor a 3
en silencio. Está arreglado: los cuatro campos van con `coalesce` y un alta sin
umbral no toca el que hubiera. Aun así, **editar el umbral desde la UI es un
`update` de esa columna** —`actualizar()` en `src/db/watchlist.ts`— y no un alta
repetida: un `insert ... on conflict` obliga a mandar la fila entera para tocar un
solo valor, que es exactamente el camino por el que se perdía.

## Qué construye la app

**Regla primera: la UI escribe en la tabla `watchlist` de Neon, la misma que lee
el ciclo. No hay almacén paralelo, ni fichero, ni estado local del navegador.**
Dos verdades sobre en qué se invierte es peor que ninguna, y el ciclo del cron no
va a leer el `localStorage` de nadie. La forma correcta es reutilizar `anadir()`,
`quitar()` y `leerWatchlist()` desde un route handler del servidor: la lógica del
`on conflict` y de la normalización ya está escrita y probada, y duplicarla en SQL
suelto dentro del frontend es garantizar que las dos versiones se separen.

**El botón "+ Añadir ticker" está siempre visible**: en la cabecera de
`/watchlist`, en el bloque de watchlist del Home y en la pestaña de watchlist de
`/settings`. Nunca dentro de un menú de tres puntos.

### El formulario

Un campo obligatorio —el ticker— y tres opcionales plegados tras un "más
opciones", porque el 90 % de las altas son solo un ticker:

```text
Ticker            obligatorio, se transforma a mayúsculas mientras se escribe
Nombre            opcional, se rellena solo si la SEC lo resuelve
Símbolo de Yahoo  opcional, solo si difiere del ticker (mercados no americanos)
Umbral            opcional, en %, por defecto 3
Vigilar documentos / vigilar precio: dos interruptores, ambos activos por defecto
```

### Validación del ticker

No hay un registro único que valide "existe o no existe": hay **dos comprobaciones
independientes**, y son independientes porque responden preguntas distintas.

1. **¿Está en EDGAR?** → `resolveTickers([ticker], SEC_USER_AGENT)`. Si aparece,
   se rellenan CIK y nombre. Si no, **no se bloquea el alta**: un ETF europeo o un
   valor no estadounidense no está en EDGAR y se vigila igual por precio, solo que
   nunca tendrá documentos. La UI lo dice con esas palabras y desactiva "vigilar
   documentos" con una nota, en vez de dejar encendido un interruptor que no puede
   hacer nada.
2. **¿Cotiza en Yahoo?** → `fetchCotizacion(simbolo)`, que lanza excepción cuando
   Yahoo no devuelve resultado. Es la comprobación que de verdad detecta un ticker
   escrito mal. **Un ISIN no es un símbolo**: uno devuelve 404, y ese error merece
   un mensaje propio ("eso parece un ISIN; busca su símbolo de Yahoo, del estilo
   `GLOBX.DE`") en vez de un "no encontrado" genérico.

Si las dos fallan, el alta **se ofrece igualmente pero avisando**: "no se ha
podido comprobar en la SEC ni en Yahoo; si lo añades, no va a generar ningún
evento". Bloquear del todo sería peor: Yahoo no es oficial, no tiene SLA y se cae
sin avisar, y un fallo suyo no puede impedir gestionar la propia lista.

Además, un aviso que no es de validación pero evita ruido: el ticker entra también
en el **filtro por reglas** (`applyRules()`), que busca la palabra completa en los
titulares con expresión regular y sin distinguir mayúsculas. Un ticker corto que
además es una palabra corriente en inglés hará pasar el filtro a media prensa del
día. Si el ticker tiene tres letras o menos, la UI lo advierte al añadirlo.

### Estados de la interacción

Todos explícitos. Ninguno es un spinner sin texto.

| Estado | Qué se ve |
|---|---|
| Escribiendo | Mayúsculas en vivo. Sin validación por cada tecla: se comprueba al enviar o al perder el foco |
| Comprobando | "Comprobando ACME en la SEC y en Yahoo…", con el botón deshabilitado. Son dos peticiones de red y tarda un segundo o dos |
| Resuelto | Nombre y CIK rellenos, y una línea de confirmación: "Acme Corp · CIK 0000000000 · cotiza en USD" |
| Parcial | "No está en EDGAR, sí en Yahoo: se vigilará su precio, no sus documentos" |
| No encontrado | Mensaje concreto por causa —símbolo mal escrito, parece un ISIN, Yahoo no responde—, y opción de añadir igualmente |
| Guardando | Botón en carga. La escritura es un `insert` contra Neon: milisegundos |
| Guardado | La fila aparece arriba y resaltada unos segundos, y un aviso explica lo que de verdad ha pasado: **"ACME entra en el próximo ciclo, que corre como mucho dentro de 15 minutos."** Es la única forma de que nadie se quede mirando la pantalla esperando datos que no van a llegar hasta la vuelta siguiente |
| Error | El mensaje real de Neon, no un "algo ha fallado". Con reintento, y sin perder lo escrito |

### Borrar

Icono en la fila, con confirmación en línea —no un modal— que diga qué implica:
"dejas de vigilar sus documentos y su precio; los eventos ya registrados se
quedan". Es cierto: `quitar()` solo borra de `watchlist`, y las filas de `events` y
`alerts` no se tocan. Deshacer inmediato durante unos segundos es barato de
implementar, porque volver a añadir es la misma operación.

**Y un aviso que la UI debe dar al borrar el último valor**: si la tabla se queda
vacía, `watchlistEfectiva()` (`src/pipeline/collect.ts`) **cae al respaldo de las
variables de entorno** `WATCHLIST` y `SEC_WATCHLIST`. Vaciar la tabla no equivale
a "no vigilar nada" si esas variables están cargadas. Enseñarlo, o alguien buscará
durante media hora por qué sigue recibiendo avisos de un valor que "quitó".

### El umbral

**Editable desde la UI**, en línea sobre la fila, con el 3 % como valor heredado
por defecto. No es un ajuste avanzado escondido: es la decisión que evita el
ruido, y el motivo por el que es por valor está en las decisiones del proyecto —un
3 % en una utility significa algo, en una biotecnológica es un martes cualquiera—.
La UI lo dice en una línea de ayuda, porque quien no lo sepa dejará el 3 en todo y
el sistema le parecerá ruidoso sin motivo.

Rango razonable en la interfaz: de 0,5 % a 20 %, con paso de 0,5. Por debajo de
0,5 casi cualquier sesión genera evento; por encima de 20 solo un desastre. Editar
el umbral es un `update` de esa columna, **no** un alta repetida: ver la trampa del
`on conflict` de más arriba.

### Dato personal

La watchlist dice en qué invierte su dueño. De ahí se deriva, y conviene que esté
escrito donde alguien lo lea antes de escribir código:

- **Vive en Neon, nunca en el repositorio.** Ni en un fixture, ni en un test, ni
  en un ejemplo de este documento, ni en una captura de pantalla de un README. Los
  tests que necesiten tickers usan inventados.
- **Ninguna consulta a la watchlist sale del servidor.** Server Components o route
  handlers; `DATABASE_URL` nunca en el navegador ni en una variable `NEXT_PUBLIC_`.
- **El dashboard desplegado no es público.** Si se sube a Vercel, con protección
  de acceso. Una URL adivinable con la cartera de alguien dentro es una filtración
  aunque nadie enlace a ella.
- **Los mensajes de error no repiten la lista.** Un error de Neon que vuelca la
  consulta con los tickers dentro acaba en un log, y los logs se comparten.

---

# 7. Huecos entre esta spec y el backend real

Todo lo que la spec original pide y **hoy no se puede pintar porque nadie lo
genera**. Comprobado en el código, no supuesto. Para cada uno: qué falta, si es
trabajo de backend previo o si la página puede salir degradada, y qué costaría.

### G1 · ~~La puntuación solo existe para lo anunciado~~ · **CERRADO**

**Cerrado el 9 de septiembre de 2026.** `mark()` acepta la nota del paso 3 y la
escribe en `events.importance_score`, `market_impact_score`, `sentiment` y
`one_liner` (migración `20260908_puntuacion.sql`). El `on conflict` pasó de `do
nothing` a un `do update` que toca **solo esas cuatro columnas** y con `coalesce`,
de forma que un marcado sin nota —un duplicado de grupo, que nadie puntuó— no borra
la que ya hubiera, y el resto del evento sigue sin reescribirse nunca.

**Qué cambia para el dashboard.** "Lo importante" en el Home y los filtros de
importancia y sentimiento de `/news` ordenan **todo lo puntuado**, no solo lo
anunciado. Las consultas de esas dos páginas salen de `events` y ya no necesitan el
join con `alerts` para jerarquizar; el join sigue haciendo falta para saber si algo
se envió y para leer `body`.

**Lo que sigue sin existir.** Un evento que no pasó el filtro por reglas nunca se
puntuó y no tiene nota: sus cuatro columnas son null y esa es la verdad. Los
componentes siguen sin pintar badge cuando falta, tal como dice la sección 3.

### G2 · El análisis profundo no se guarda estructurado

**Qué falta.** `Analysis` —`why_it_matters`, `catalysts`, `risks`,
`affected_assets`, `what_to_watch`— se genera, se formatea y se tira. Lo único que
persiste es la prosa dentro de `alerts.body`.

**Consecuencia.** El panel de detalle de `/news` no puede tener secciones de
catalizadores y riesgos, y los `AssetChip` de activos afectados no tienen fuente. Se
paga un modelo caro por un análisis que la base no puede consultar.

**Veredicto: la página sale degradada** —se enseña `body` en preformateado—, pero
esto es una pérdida de información real y merece arreglarse pronto. Una columna
`analysis jsonb` en `alerts`, rellenada en `saveAlert()`, lo resuelve sin tocar el
esquema de nadie. Una tabla `event_assets (event_id, symbol, direction, confidence)`
sería lo correcto para los chips y para el filtro por activo.

### G3 · No hay régimen de mercado

**Qué falta.** Todo. No hay tabla, ni cálculo, ni ingesta de sus componentes: VIX,
DXY, spreads de crédito y liquidez no entran por ninguna fuente. Las tres series de
FRED que sí entran —IPC, paro y bono a 10 años— no bastan para un régimen, y
derivar uno de ellas sería inventar.

**Consecuencia.** `RegimeBanner` y la página `/regime` no existen en la primera
versión, y el layout global no reserva su sitio.

**Veredicto: backend previo, y no pequeño.** Está en el cronograma como días 15-16,
después del dashboard. El orden es correcto y no hay que forzarlo.

### G4 · No hay precios ni universo de activos

**Qué falta.** Yahoo se consulta en cada ciclo, pero **solo se persiste la sesión
que supera el umbral del valor**: `toEvent()` devuelve null en caso contrario. No
hay tabla de cotizaciones ni de histórico. Y el universo de la spec —índices,
yields, DXY, oro, petróleo, crypto— no se ingiere: `SERIES` tiene tres entradas y
la fuente `coingecko` está declarada en el enum de `src/schema/event.ts` **sin
ningún módulo detrás**.

**Consecuencia.** `/markets` no se construye. El "market snapshot" del Home se
queda en las tres series de FRED. La columna de variación de `WatchlistRow` no
tiene de dónde salir sin cotizar en vivo.

**Veredicto: backend previo para `/markets`; el Home sale degradado.** Lo mínimo
sería una tabla `quotes (symbol, session_date, close, change_pct)` escrita en cada
ciclo con lo que ya se descarga —hoy se tira— más una lista de símbolos de
referencia. `fetchSerie()` y `media()` ya existen y darían el histórico del gráfico
sin escribir nada nuevo.

### G5 · Resultados sin cifras, y consenso inexistente

**Qué falta.** Dos cosas distintas que la spec trata como una:

- **Cifras de resultados.** El sistema sabe que una empresa ha presentado —el
  apartado 2.02 de un 8-K, vía `etiqueta()` en `src/sources/sec-edgar.ts`— pero no
  lee su contenido. No hay ingresos, ni beneficio por acción, ni guidance, ni
  métricas propias como RPO o ARR. Sacarlas exige descargar y parsear el anexo 99.1
  del 8-K, que es HTML libre redactado por cada empresa a su manera. Es un proyecto
  en sí mismo.
- **Consenso de analistas.** `events.consensus` existe como columna y **es siempre
  null**: no hay fuente gratuita fiable y la decisión sigue abierta en la ficha del
  proyecto. Sin consenso no hay "beat/miss", ni flecha, ni columnas de consenso y
  sorpresa en `/calendar`.

**Consecuencia.** `/earnings` no se construye. `/calendar` pierde tres de sus seis
columnas.

**Veredicto: backend previo, el más caro de la lista.** Mientras tanto, `/earnings`
se sustituye por una vista filtrada de `/news` que diga qué empresa ha presentado y
cuándo, con enlace al documento. Si algún día hay consenso introducido a mano —una
de las tres salidas que la ficha del proyecto contempla—, `/settings` sería el sitio
natural para meterlo, y la columna ya está esperando en la tabla.

### G6 · Sector, país y horizonte

**Qué falta.**

- **Sector**: no existe en ninguna parte. Ni en `events`, ni en `watchlist`, ni se
  infiere. Clasificar por sector exige una tabla de referencia (ticker → sector) o
  pedírselo al modelo en el paso 3, que sería la vía barata: un campo más en el
  esquema Zod de `Scoring` y una columna más.
- **Horizonte temporal** (inmediato / semanas / estructural): tampoco existe. Mismo
  arreglo posible, un campo más en `Scoring`. Con cuidado de que ese campo no
  arrastre el problema que tuvo G1: cualquier campo nuevo del paso 3 se escribe en
  `events` desde `mark()`, no solo al alertar. Si no, filtra sobre el subconjunto
  anunciado.
- **País**: `events.country` existe, pero es **un emoji heredado del feed**, no del
  contenido. Una noticia de CNBC sobre el BCE lleva `🌐` porque así está declarado
  el feed. Sirve de adorno informativo; **no sirve como faceta de filtrado** y no
  debe ofrecerse como tal.

**Veredicto: los filtros de sector y horizonte no se pintan** hasta que exista el
campo, y el de país tampoco mientras sea la bandera del feed. **La página sale
igual**: filtrar por `kind`, por `source` y por `official` cubre en la práctica lo
que la spec quería conseguir con sector y país, y esos tres sí son datos ciertos.

### G7 · Ajustes y observabilidad no son editables ni consultables

**Qué falta.** La configuración vive en variables de entorno leídas por
`loadConfig()` al arrancar el proceso; en producción son secretos de GitHub. El
dashboard no comparte proceso con el cron y no puede cambiarlas. Y no hay tabla de
ejecuciones: qué corrió, cuándo, cuántos eventos, qué falló. Eso está solo en los
logs de Actions.

Tampoco existe el **morning brief** que la spec da por hecho en `/settings` ("hora
del morning brief"). Lo que hay es `npm run agenda` con su workflow a las 06:30
UTC, y esa hora está escrita en el cron de `.github/workflows/agenda.yml`: cambiarla
es editar el YAML, no un ajuste de aplicación.

**Veredicto: `/settings` sale degradada y sigue siendo útil.** Watchlist editable;
alertas y fuentes en lectura, diciendo dónde se cambian; y como estado del sistema,
lo que `missingVars()` produce más `max(first_seen_at)` de `events` como indicio de
vida del cron. Editar de verdad exigiría una tabla `settings` que `loadConfig()`
leyera, y un registro de ciclos que `main.ts` escribiera al terminar: las dos son
baratas y ninguna existe hoy.

### G8 · Grupos y orden en la watchlist

**Qué falta.** La tabla `watchlist` no tiene columna `grupo` ni `orden`. Los grupos
por temática y el reordenar arrastrando que pide la spec no tienen dónde guardarse.

**Veredicto: la página sale degradada** con orden alfabético, que es lo que devuelve
`leerWatchlist()`. El arreglo es una migración de dos columnas —al estilo `add
column if not exists`, como todas— y es el hueco más barato de cerrar de los ocho.

### Resumen

| Hueco | Bloquea | Sale degradada | Coste de cerrarlo |
|---|---|---|---|
| ~~G1 puntuación de lo no anunciado~~ | — | — | **cerrado el 9 de septiembre** |
| G2 análisis estructurado | — | detalle de `/news` | Bajo |
| G3 régimen de mercado | `RegimeBanner`, `/regime` | — | Alto |
| G4 precios y universo de activos | `/markets` | Home, `/watchlist` | Medio |
| G5 resultados y consenso | `/earnings` | `/calendar` | Alto |
| G6 sector, país, horizonte | filtros de sector y horizonte | `/news` | Bajo el sector, medio el resto |
| G7 ajustes y observabilidad | edición en `/settings` | `/settings` | Medio |
| G8 grupos de watchlist | agrupar y reordenar | `/watchlist` | Muy bajo |

---

# 8. Responsive y dark mode

```text
Dark mode:   obligatorio desde el primer componente, no un extra posterior. Todos
             los tokens de la sección 2 con su variante oscura definida ANTES de
             escribir el primer componente visual. Añadirlo después es repasar
             cada archivo del proyecto

Breakpoints: el grid de 2 columnas de Home y Watchlist colapsa a 1 por debajo de
             ~900px. La navegación horizontal pasa a menú por debajo de ~640px

Móvil:       NewsCard y MetricCard mantienen su estructura; solo cambia el grid
             contenedor. No se simplifica el contenido de las tarjetas en móvil,
             solo el layout
```

Dos casos que este backend impone y que conviene resolver pronto: **la tabla de
`/calendar` scrollea horizontalmente dentro de su contenedor**, nunca haciendo
scrollear la página; y **los emojis de bandera de `events.country`** no se
renderizan igual en todas las plataformas —en Windows, por ejemplo, salen como dos
letras—. Si eso molesta, se mapean a un componente propio en el frontend; lo que no
se hace es cambiar el dato en la base, que es el que consume la alerta de Telegram.

---

# 9. Orden de construcción

No se construyen páginas sueltas antes de tener el sistema. El orden difiere del de
la spec original en un punto deliberado: **se empieza por `/alerts`, no por el
Home**, porque es la única página cuyos datos están completos y sirve para validar
todos los componentes contra filas reales antes de que ninguna decisión visual se
haya repetido siete veces.

1. **Tokens** de la sección 2 como variables CSS o config de Tailwind, con dark
   mode desde el primer momento.
2. **Capa de datos**: las consultas a Neon en el servidor, tipadas contra las
   columnas de la sección 0. Reutilizar `src/db/watchlist.ts` en vez de reescribir
   su SQL. `DATABASE_URL` nunca sale del servidor.
3. **Componentes** de la sección 3 en aislamiento, en una página `/dev-components`
   temporal donde se vean todos juntos en claro y en oscuro — **incluidos sus
   estados vacíos y de carga**, que en esta app son la mitad de los casos reales.
4. **Layout global** de la sección 4: barra superior y shell de página. Sin franja
   de régimen.
5. **`/alerts`**, la página de referencia. Datos completos, ningún hueco.
6. **`/news`**, que reutiliza `NewsCard` y añade los filtros que sí existen.
7. **`/watchlist`, con el alta de tickers de la sección 6.** Es la primera
   escritura de la app y el requisito propio de Alberto: no se deja para el final.
8. **Home**, que a estas alturas es composición de lo ya construido.
9. **`/calendar`** contra `fetchAgenda()`, con sus columnas reducidas.
10. **`/settings`**, con la watchlist editable y el resto en lectura.

`/markets`, `/earnings` y `/regime` **no entran en este sprint**. Sus huecos son de
backend y están en el cronograma después del dashboard.

Base de componentes primitivos: shadcn/ui —botones, campos, desplegables,
acordeón— y encima los componentes de dominio (`NewsCard`, `ImportanceBadge`…). Si
una página necesita una variante nueva de un componente, se extiende el existente;
no se crea uno paralelo. Nada de gráficos avanzados: si llega a haber un gráfico,
una línea simple. **Prioridad: que todas las páginas listadas existan y sean
usables, por encima de que una sola tenga visualizaciones sofisticadas.**

Y la regla que cierra el documento, porque es la que decide las discusiones que
este texto no ha previsto: **si una página necesita un campo que la sección 0 no
lista, no se rellena. Se declara el hueco y se sigue.**

---

# 10. Lo construido (9 de septiembre de 2026)

Los diez pasos de la sección 9, hechos. Lo que se apartó de este documento y por
qué, que es lo único que este apartado añade:

- **Sin shadcn/ui ni sus primitivos.** La sección 9 los proponía como base. No se
  han usado, y el motivo es el principio 1: shadcn trae su propia capa de tokens
  semánticos (`--background`, `--primary`, `--muted`…) que se solaparía con la de
  la sección 2, y dos sistemas de color en la misma app es exactamente cómo se
  rompe "el color siempre significa lo mismo". Los tokens de la sección 2 están en
  `app/globals.css` como variables CSS expuestas a Tailwind v4 con `@theme
  inline`, y los primitivos que esta versión necesita —desplegable, campo,
  interruptor, acordeón— son elementos nativos: `select`, `input`, un `button` con
  `aria-pressed` y `details`. Accesibles de serie y cero dependencias, que es la
  misma decisión que ya se tomó con el lector de RSS. **Es reversible**: si algún
  día hace falta un componente que de verdad cueste (un combobox, un date range),
  se añade encima de estos tokens.
- **El dashboard vive en el mismo paquete que el ciclo**, en `app/`, y no en un
  paquete aparte. Sus páginas leen `src/db/lectura.ts` y su formulario llama a
  `src/db/watchlist.ts`; con dos paquetes habría que duplicar ese SQL —incluido el
  `on conflict` que ya tuvo un fallo silencioso— o montar un truco de resolución
  entre carpetas. El precio es que el cron instala también React: sale gratis
  —Actions ilimitadas en repositorio público— y `npm ci` instala lo que diga el
  lockfile, así que el árbol del dashboard solo cambia cuando alguien lo cambia.
- **No hay página `/dev-components`.** El paso 3 la pedía para ver los componentes
  en aislamiento. Con datos reales en la base desde el primer momento, `/alerts` y
  `/news` ya enseñan todos los estados —con nota y sin ella, obsoleto, enviado,
  con análisis profundo y sin él— contra filas de verdad, que es mejor prueba que
  una página de muestras.
- **Los filtros son un `form` GET, sin JavaScript.** El estado vive en la URL: se
  comparte, se recarga y se vuelve atrás. Los dos únicos componentes de cliente
  son la navegación —necesita saber la ruta actual— y el alta de la watchlist, que
  necesita las mayúsculas en vivo y el estado "Comprobando…".
- **`sorpresa()` se movió a `src/notify/telegram.ts`** y la usan la alerta y las
  tres pantallas que imprimen una sorpresa. Se descubrió al mirar la página: la
  misma cifra del mismo evento salía como "-0,2 pp (vs anterior)" en Telegram y
  como "-0,2% vs anterior" en la ficha.

Lo que **no** entra, como estaba previsto: `/markets`, `/earnings` y `/regime`.
Sus huecos son de backend (G3, G4, G5) y no están en la navegación, porque un
enlace a una página que no puede tener contenido promete un dato que el sistema no
produce.

## Lo que falta antes de desplegarlo

**El dashboard enseña una cartera y el repositorio es público.** Si se sube a
Vercel, se sube con protección de acceso (Deployment Protection → Vercel
Authentication, que está en el plan Hobby). Una URL adivinable con la watchlist
dentro es una filtración aunque nadie enlace a ella.

Variables que necesita el despliegue: `DATABASE_URL` —sin ella no hay nada que
leer— y `FRED_API_KEY`, que la agenda consulta en vivo. `SEC_USER_AGENT` es
opcional y solo la usa el alta de un valor para resolver su CIK. Ninguna es
`NEXT_PUBLIC_`.
