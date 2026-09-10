# Cobertura RSS, tandas y verificación

> Las cifras de filtros de este documento corresponden a la primera ampliación.
> La [evaluación de dos niveles](dos-niveles-noticias.md) conserva esa referencia
> y mide la política posterior, donde una fuente oficial ya no pasa automáticamente.

Comprobado desde este equipo el **10 de septiembre de 2026, 12:05 UTC**. Solo GET públicos. El código conserva `core` como selección predeterminada. No se activó ninguna tanda en producción. Un endpoint accesible no equivale a una licencia abierta ni garantiza su disponibilidad futura.

## Registro y aportación

Los ocho anteriores siguen en `core`: Fed, BCE, SEC, CNBC, Yahoo y las secciones economía, indicadores y bolsa de Investing. Las incorporaciones añaden tres editores primarios y BLS, además de dos secciones temáticas de un editor ya existente. Cinco secciones de Investing cuentan como **un editor**. Lo mismo ocurre con los tres BLS y los dos BoE.

| Id / tanda | Editor · tema · región · idioma | Endpoint oficial | Fechas disponibles | Aportación frente a core |
|---|---|---|---|---|
| `bls-employment` / 1 | Bureau of Labor Statistics · empleo · EE. UU. · inglés | [Empleo](https://www.bls.gov/feed/empsit.rss) | Atom `published` y `updated`, con offset; periodo del dato en el comunicado | Comunicado laboral directo, sectores y revisiones; no depende de la selección de un medio |
| `bls-cpi` / 1 | BLS · precios al consumidor · EE. UU. · inglés | [IPC](https://www.bls.gov/feed/cpi.rss) | Atom `published` y `updated`, con offset | Desglose narrativo de inflación y vivienda que una serie FRED no cuenta |
| `bls-ppi` / 1 | BLS · precios al productor · EE. UU. · inglés | [PPI](https://www.bls.gov/feed/ppi.rss) | Atom `published` y `updated`, con offset | Inflación de bienes y servicios desde la publicación primaria |
| `eia-today` / 1 | Energy Information Administration · energía · EE. UU. y contexto mundial · inglés | [Today in Energy](https://www.eia.gov/rss/todayinenergy.xml) | `pubDate`, usa literalmente `EST`; el periodo económico aparece en el texto | Producción, capacidad, gas, electricidad y comercio energético; no solo precio bursátil |
| `boe-news` / 2 | Bank of England · finanzas y medidas institucionales · Reino Unido · inglés | [News](https://www.bankofengland.co.uk/rss/news) | `pubDate`, con offset británico | Comunicados oficiales británicos y mercado financiero local |
| `boe-publications` / 2 | Bank of England · política monetaria e informes · Reino Unido · inglés | [Publications](https://www.bankofengland.co.uk/rss/publications) | `pubDate`, con offset británico | Incluye el informe monetario que no aparece necesariamente en News; también contiene investigación rutinaria |
| `boj-news` / 2 | Bank of Japan · política monetaria y estadísticas · Japón · inglés | [What's New](https://www.boj.or.jp/en/rss/whatsnew.xml) | `pubDate`, `+0900`; enlaces PDF/HTML, algunos reutilizados | Opiniones de reuniones, discursos y datos japoneses desde su emisor |
| `investing-forex` / 3, bloqueada | Investing.com · divisas · mundial · inglés | [Forex News](https://www.investing.com/rss/news_1.rss) | `pubDate` sin zona; UTC por convención explícita existente | Reacciones de libra, yen, euro y dólar que faltan en las tres secciones anteriores |
| `investing-commodities` / 3, bloqueada | Investing.com · materias primas · mundial · inglés | [Commodities & Futures](https://www.investing.com/rss/news_11.rss) | Igual que divisas | Oferta petrolera y metales; incluye ruido técnico que debe filtrarse |
| `eia-weekly-petroleum` / 3, bloqueada | EIA · petróleo e inventarios · EE. UU. · inglés | [This Week in Petroleum](https://www.eia.gov/petroleum/weekly/includes/week_in_petroleum_rss.xml) | Cuatro `pubDate` inválidos; periodos en el texto | Sería útil para inventarios semanales, pero esta URL no aporta datos actuales verificables |

Los enlaces se extrajeron del catálogo del propio editor: [BLS](https://www.bls.gov/feed/), [EIA](https://www.eia.gov/tools/rssfeeds/), [BoE](https://www.bankofengland.co.uk/rss), [portada inglesa de BoJ](https://www.boj.or.jp/en/) e [Investing RSS](https://www.investing.com/webmaster-tools/rss). La verificación automática confirmó cada URL en su catálogo. No se incluyeron feeds generales, opinión ni duplicados de `news_14`, `news_95` o `news_25`.

## Condiciones y atribución

- **BLS:** material gubernamental de dominio público, salvo imágenes de terceros. Solicita citar al Bureau of Labor Statistics. Conservar fuente, fecha y enlace; no usar su emblema. [Condiciones BLS](https://www.bls.gov/bls/linksite.htm).
- **EIA:** permite reutilizar sus publicaciones y datos; pide atribución con fecha. Identificar una interpretación/traducción propia y enlazar el original. Logos, fotografías y aportaciones de terceros tienen excepciones. No se descargan imágenes. [Reutilización EIA](https://www.eia.gov/about/copyrights_reuse.php).
- **BoE:** descarga, visualización e impresión para uso personal o interno no comercial; otros usos necesitan autorización. Atribuir Bank of England, fecha y enlace. El análisis de News Monitor debe identificarse como propio. No confundir estas condiciones con la licencia particular de su base estadística. El banco puede restringir uso excesivo. [Legal BoE](https://www.bankofengland.co.uk/legal).
- **BoJ:** permite copia/reproducción no comercial con atribución, salvo materiales señalados e imágenes; el uso comercial requiere permiso. Preservar el titular original y distinguir cualquier interpretación. Enlaces identificados como Bank of Japan, sin aparentar aprobación. [Copyright BoJ](https://www.boj.or.jp/en/copyright.htm), [enlaces y disponibilidad](https://www.boj.or.jp/en/about/abouthp.htm).
- **Investing:** el catálogo ofrece suscripción RSS, pero el aviso del mismo sitio reserva almacenamiento, reproducción y redistribución sin permiso. No se encontró una licencia específica que resuelva el uso de nuevas secciones dentro de una cola persistente y análisis externo. Los dos candidatos tienen `enabled: false, disabledReason: "terms_review"`. Falta confirmar el alcance permitido antes de habilitarlos; no se contactó al editor. Los tres feeds existentes se conservan. Atribuir Investing.com y autor si consta en el original; no descargar artículos completos ni quitar procedencia. [Catálogo y aviso](https://www.investing.com/webmaster-tools/rss), [términos](https://www.investing.com/about-us/terms-and-conditions), [solicitud de sindicación del propio editor](https://www.investing.com/webmaster-tools/real-time-news-feed).

Esta revisión documenta lo publicado por cada editor; no convierte un uso privado en autorización para redistribución pública. No hubo cuentas nuevas, API de pago ni contratación.

## Ejemplos observados y límites

- **BLS:** el comunicado de [empleo de agosto](https://www.bls.gov/news.release/archives/empsit_09042026.htm) incorporaba el cambio de empleo y su composición. Los comunicados de [IPC](https://www.bls.gov/news.release/archives/cpi_08122026.htm) y [PPI](https://www.bls.gov/news.release/archives/ppi_08132026.htm) añadían contexto de vivienda, bienes y servicios. Son hechos complementarios a la cifra estructurada de FRED, no tres estimaciones nuevas de consenso.
- **EIA:** [descuentos regionales del gas de Nueva Inglaterra frente a Henry Hub](https://www.eia.gov/todayinenergy/detail.php?id=68124) muestra diferencias de oferta y consumo; [capacidad y exportación de GNL](https://www.eia.gov/todayinenergy/detail.php?id=68064) añade información física de energía. Today in Energy no sustituye al boletín semanal de inventarios.
- **BoE:** el feed de publicaciones incluía el [informe monetario de julio](https://www.bankofengland.co.uk/monetary-policy-report/2026/july-2026) y la [encuesta empresarial de agosto](https://www.bankofengland.co.uk/decision-maker-panel/2026/august-2026). News por sí solo no cubría ese informe. Ambos feeds comparten presupuesto por editor.
- **BoJ:** [opiniones de la reunión de julio](https://www.boj.or.jp/en/mopo/mpmsche_minu/opinion_2026/opi260731.pdf) y [discurso sobre actividad, precios y política monetaria](https://www.boj.or.jp/en/about/press/koen_2026/ko260910a.htm). Las estadísticas ordinarias también pasan por oficiales: necesitan prioridad más baja y puntuación, no una alerta automática.
- **Investing:** [libra y expectativas sobre BoE](https://www.investing.com/news/forex-news/sterling-today-pound-rises-as-boe-rate-hike-bets-build-4895211), [producción de OPEC](https://www.investing.com/news/commodities-news/opec-oil-output-falls-in-august-reuters-survey-shows-4895425) y [Brent y transporte marítimo](https://www.investing.com/news/commodities-news/brent-holds-above-100-as-tanker-attacks-deepen-supply-fear-4894851) eran ejemplos de aporte temático ausentes de la foto core. La sección de materias primas también trajo cuatro piezas de niveles técnicos intrahora: pertenecer a Noticias no basta para considerarlas señales útiles.

En esta foto, las 197 URLs de las nuevas primarias y las 20 de Investing no aparecían en core. Es una comparación puntual de enlaces; no demuestra que todas las historias sean exclusivas ni que nunca las publique otro editor. BLS/BoE conservan meses de histórico: no deben puntuarse como novedad del día de activación.

## Resultado reproducible

Informe privado de la primera medición: `.cache/fuentes-2026-09-10T12-05-40-000Z.json` (ignorado por git). Los datos siguientes preceden a la ampliación final de reglas; permiten comparar la misma muestra sin nuevas llamadas.

| Tanda | Endpoints | Elementos normalizados | Últimas 24 h / 7 días | Bytes RSS por captura |
|---|---:|---:|---:|---:|
| core | 8 | 169 | 26 / 89 | 103.255 |
| 1: BLS + EIA | 4 | 50 | 1 / 4 | 34.519 |
| 2: BoE + BoJ | 3 | 147 | 4 / 17 | 63.780 |
| 3: Investing, solo prueba | 2 | 20 | 15 / 20 | 8.970 |
| EIA semanal, bloqueado | 1 | 0 de 4 | no medible | 2.172 |

Todos devolvieron HTTP 200. EIA semanal devolvió cuatro fechas `################### EST` y documentos de octubre de 2025. Se descartó su activación; no se inventó la fecha actual a partir de la captura. Se conserva como candidato comprobable.

En las reglas iniciales pasaban 7/10 noticias de divisas y 2/10 de materias primas. Faltaban BoE/BoJ abreviados, cambios de tipos, producción de OPEC y algunos canales marítimos; también se descartaba correctamente buena parte de los niveles técnicos. El nuevo test de cobertura y los tests de reglas comprueban recuperación selectiva y agrupación, sin bajar el umbral de alerta. Las primarias pasan el primer filtro, pero deben competir con prioridad, envejecimiento y cuota por editor.

**Tras la corrección local**, una segunda comprobación a las 12:11 UTC (`.cache/fuentes-2026-09-10T12-11-47-283Z.json`) dio **8/10 en divisas y 5/10 en materias primas**. Se reprodujo además la primera muestra contra las reglas nuevas, sin red, para separar el efecto de los filtros de la rotación del RSS: recupera exactamente cuatro candidatas (BoE/libra, Brent/transporte, producción de OPEC y oro/rendimiento del Treasury). Conserva fuera las cinco piezas de niveles técnicos/resumen genérico de materias primas y las dos piezas de divisas sin señal identificada. El motivo pasa a ser explícito: `macro`, `geopolitics`, `market` o `low_signal`.

Las pruebas `rules-coverage.test.ts` y `group-coverage.test.ts` verifican esos patrones reformulados, negativos con moneda/metal genéricos, publicaciones separadas por meses y recortes de 25 frente a 50 puntos. La agrupación mantiene dos publicaciones cuantitativamente distintas aunque sus titulares sean casi iguales, y sigue agrupando reproducciones del mismo hecho durante una misma ventana. No se ha verificado todavía su precisión sobre un periodo continuo de producción.

Fechas: `publication_at` conserva `pubDate`/`published`/`dc:date`; una actualización Atom sin publicación queda con publicación desconocida. `retrieved_at` es la descarga y la cola conserva `first_captured_at`. `data_period_at` queda en null en RSS: el mes al que se refiere BLS no es el instante en que publica el comunicado. El parser recupera `content` de BLS como entradilla. BoJ incorpora publicación a su identidad porque reutiliza algunas URLs; recapturar una misma edición conserva el id. Los IDs core no cambian.

## Activación por tandas y reversión

1. Ejecutar pruebas locales sin credenciales:

   ```powershell
   npx vitest run test/fuentes-cobertura.test.ts test/fuentes.test.ts test/reglas-cobertura.test.ts test/rules-coverage.test.ts test/agrupar.test.ts test/group-coverage.test.ts
   npx tsx scripts/verificar-fuentes.ts '--batches=core,batch1'
   ```

2. Cuando se autorice operar producción y la cola esté disponible, elegir `RSS_FEED_BATCHES=core,batch1`. `RSS_FEEDS`, si tiene IDs explícitos, prevalece; comprobar que no oculta la tanda. Mantener el cupo de puntuación. Observar al menos un día y una publicación BLS real: pendientes, edad máxima, descartes por motivo, porcentaje de rutinarias, cuota por editor, errores y duplicados.
3. Si no crece la edad de pendientes y las muestras agrupadas son correctas, verificar `--batches=core,batch1,batch2`, revisar BoE rutinario y habilitar esa combinación en una activación posterior. Los dos feeds BoE no obtienen dos cuotas.
4. Para estudiar candidatos sin activarlos:

   ```powershell
   npx tsx scripts/verificar-fuentes.ts '--batches=core,batch3' --include-disabled
   ```

   `batch3` no habilita sus filas bloqueadas. Investing exige cerrar la revisión de condiciones, mantener la atribución y pasar los tests de filtros; después cambiar explícitamente `enabled` y probar primero una sección. EIA semanal exige fechas válidas y una publicación reciente comprobable del editor.
5. Reversión de fuentes: devolver `RSS_FEED_BATCHES=core` o retirar los IDs de `RSS_FEEDS`. Esto frena nuevas capturas. No elimina la cola ni borra el registro de entregas. Si hay que detener también el procesamiento de pendientes de una tanda, pausar el procesamiento mediante el procedimiento general de la cola; cambiar la selección RSS por sí solo no cancela trabajo ya capturado.

El verificador solo carga módulos puros y GET de URLs públicas del registro. No lee `.env`, la watchlist ni la base de datos; no puntúa con LLM ni envía Telegram. Usa dos peticiones concurrentes y timeout de 12 segundos. Guarda los ejemplos en `.cache/`; la consola publica conteos, IDs del catálogo y códigos de error. Una fuente activa inválida causa salida de error al final sin impedir verificar las otras.

## Impacto estimado

La foto de las dos tandas primarias ocupa **122.066 bytes de eventos JSON** para 197 elementos (sin índices ni historial de la cola). La primera captura añade alrededor de 0,12 MB de payload; presupuestar **0,6–1,6 MB** con filas, índices, estados y margen de implementación. Medir el tamaño real de las tablas tras activación; no se ha aplicado una migración remota.

A 48 capturas/día, siete endpoints nuevos suman **336 GET/día** y unos **4,7 MB/día** de XML con el tamaño observado. No equivalen a 336 noticias nuevas: la unicidad impide volver a crear trabajo. La foto contiene 21 publicaciones nuevas en siete días, no una medición continua. Para planificar, 3–10 noticias primarias/día y 3–8 KB persistidos por noticia implican aproximadamente **3–30 MB/año**. Son escenarios con margen, no una promesa de volumen.

Investing rotaba diez entradas en unas horas en materias primas. Antes de activarlo, presupuestar y medir 20–120 noticias/día entre ambas secciones: **22–350 MB/año** a 3–8 KB por noticia, con variación alta. El cupo por editor evita monopolio, pero una cola que crece sin drenarse necesita revisar filtros/capacidad, no borrar silenciosamente excedentes.

El límite de scoring sigue acotando el máximo por ciclo. Cada nota nueva que llegue a scoring añade procesamiento; guardar pendientes no aumenta por sí solo llamadas LLM. Si se conserva el cupo de 12, 48 ejecuciones/día permiten como máximo 576 puntuaciones/día entre todas las fuentes. Con huecos reales esa capacidad es menor. El coste monetario depende del modelo, tokens y presupuesto ya existentes: aquí no se hizo ninguna llamada de pago.
