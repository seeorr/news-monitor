# Noticias en dos niveles - entrega local del 10-09-2026

Implementado en este repositorio, sin ejecutar comandos de commit ni activación remota. Esta guía
complementa [la cola](captura-persistente.md), [las fuentes](fuentes-cobertura.md)
y [el disparador externo](disparador-externo.md). Sustituye sus afirmaciones
anteriores de que una primaria siempre pasa o de que la espera nunca caduca.
La ficha del proyecto, las notas, la watchlist y los otros repositorios no se han modificado.

## Hitos y arquitectura

1. **Capturar antes del cupo.** `capture_queue` conserva snapshot, primera captura,
   publicación, periodo macro, intentos, estado y motivo. `events` es la proyección
   procesada; existir en la cola no activa `SeenStore.has`. Estados: pendiente,
   en procesamiento con lease, puntuada, descartada y fallo reintentable.
2. **Repartir trabajo.** Rondas por editor, prioridad material y +1 cada 6 horas.
   Una relación directa con la watchlist recibe prioridad; una mención incidental
   no recibe ese privilegio. Las rutinas no acaparan el cupo. Tres feeds BLS o
   varias secciones Investing cuentan como un editor.
3. **Ampliar fuentes.** Catálogos, endpoints, condiciones, atribución y fechas
   comprobados por GET públicos. Tanda 1: BLS empleo/IPC/PPI y EIA Today. Tanda 2:
   BoE News/Publications y BoJ. Investing divisas/materias primas permanecen
   bloqueadas por condiciones; no duplican sus tres feeds existentes. EIA semanal
   permanece bloqueado por fechas inválidas. Las tandas nuevas no están activadas
   en producción; `core` conserva los ocho feeds anteriores.
4. **Aislar fallos.** Tres fuentes concurrentes, 45 s por fuente, 180 s total;
   persistencia en cuanto cada tarea termina. EDGAR trabaja por empresa y filtra
   formularios relevantes antes de limitar los resultados. Lee hasta dos archivos
   históricos y registra truncamiento. El cupo de archivos sigue siendo finito.
5. **Decidir destinos.** `news_decisions` guarda versión, nivel, seis decisiones,
   motivos y evidencia; `news_usage` reserva volumen e IA antes del efecto externo.
   Ambos tienen implementación en archivo, memoria y Neon. La lectura del
   dashboard muestra el nivel asignado aparte del acuse de envío.

## Dónde se pierde o aplaza una noticia

| Etapa | Registro y explicación |
|---|---|
| No capturada | Fallo de fuente, feed no seleccionado, ventana RSS o hueco entre ejecuciones. Su cantidad es desconocida: no se calcula con las entradas que sí llegaron. |
| Rechazada | Snapshot guardado con `stale_at_capture`, `rules_no_match` o `rules_low_signal`. No consumir scoring no significa no haber capturado. |
| Duplicada | `duplicate_story`: el representante se puntúa y la copia conserva su motivo. |
| Cupo | Permanece pendiente; el límite 12 no elimina excedentes. `budget_exhausted` es reintentable. |
| Puntuada sin envío | Score guardado; nivel dashboard/resumen, cuota aplazada, falta de transporte o entrega ya reclamada. Consultar `news_decisions` y `alert_deliveries`. |
| Resumen matinal | Elegibilidad explícita, últimas 24 h por primera proyección, hasta cinco entradas; se excluye cualquier entrega ya reclamada de la política nueva para evitar repetirla. |

`npm run audit:queue` muestra capturadas, únicas, procesadas, pendientes,
antigüedad y descartes por fuente. `npm run audit:news` muestra niveles y reservas
del día UTC sin IDs, titulares ni watchlist. Para una investigación privada por
noticia, cruzar `capture_queue.id = news_decisions.event_id = events.id` y
`alert_deliveries.event_id`; no volcar snapshots o decisiones completas en logs
públicos. `audit:queue -- --detalle` escribe datos privados solo en `.cache`.

## Relevancia y seis decisiones

`relevance.ts` separa tema, evidencia, hecho/opinión/rumor/promoción/rutina y
relación directa/incidental con la watchlist. Detecta nombres y símbolos con las
protecciones anteriores (por ejemplo, ON sin notación financiera no es un ticker).
Una acción económica concreta puede entrar sin watchlist. Un tema aislado no
demuestra un hecho. Informes primarios seleccionados pueden entrar con evidencia
limitada para scoring y resumen, sin convertirse automáticamente en Telegram.

| Decisión | Regla por defecto |
|---|---|
| Captura | Guardar todo evento normalizado disponible, incluso el descarte |
| Procesar | Relevancia admitida y no caducada ni antigua en primera captura |
| Dashboard | Relevancia admitida y puntuación al menos 3 |
| Aviso breve | Hecho, no stale, al menos 5 y no importante |
| Resumen | Relevancia útil y al menos 4, sin asignación a breve/importante; después filtros del resumen |
| Importante | Hecho con evidencia suficiente y al menos 7; relación material directa con watchlist permite 6 |

El umbral general importante sigue en 7. `needs_alert` del modelo no sustituye la
decisión determinista de dos niveles. `DEEP_ANALYSIS_THRESHOLD` queda para modo
legacy; en dos niveles el análisis depende de la decisión importante y evidencia.
Se conservan los modelos existentes; no hay clasificador ambiguo adicional.

La evidencia es una heurística, no verificación externa de la noticia: dato
estructurado, entradilla con contexto o adquisición/quiebra explícita. Las reglas
no comprenden todo el lenguaje natural. Queda un falso positivo condicional en
la reserva y hay discursos con contenido útil que requerirían extracción adicional.
La personalización queda pendiente de los ejemplos solicitados una sola vez al usuario.

Los destinos de noticias en Telegram son excluyentes desde la asignación: una
noticia breve aplazada no entra antes en el resumen y vuelve a enviarse después.
El dashboard sí puede mostrar todos los niveles. Las filas históricas sin decisión
conservan la lectura anterior; no se reconstruyen sus decisiones retrospectivamente.

## Agrupación y actualizaciones

Jaccard sigue en 0,6. Se impide fusionar cifras diferentes (incluida entradilla),
negación, sujeto explícito distinto, periodo distinto o publicaciones separadas
por más de 24 horas. Puede reducir el agrupado de paráfrasis; es una decisión
conservadora contra ocultar hechos. No resuelve identidades empresariales o
traducciones arbitrarias. Los rasgos se cachean por snapshot para evitar recalcular
regex en cada par; la prueba con más de 500 noticias volvió a quedar dentro del tiempo.

Una noticia del mismo sujeto y tema que añade un cambio material puede enlazarse
mediante `updateOf`. Si la anterior se envió y la nueva es importante, la alerta
muestra **Antes / Ahora** con las dos frases guardadas. Cada novedad tiene su ID;
el vínculo no borra ni reclasifica retrospectivamente el aviso anterior.

## Entrega y límites

El análisis profundo solo se pide para importantes con contexto. Si falla, se
envía el hecho breve respaldado y se guarda `deliveryFormat=brief_fallback`,
manteniendo el nivel asignado importante. Cifras nuevas se rechazan; truncado solo
por frases completas. Se omite prosa sin soporte y no se rellenan mensajes para
alcanzar una longitud. Los avisos pueden quedar por debajo de 250/700 caracteres
si falta material. El número presente en la fuente no demuestra por sí solo que
la relación causal o la traducción del modelo sea correcta.

Se reclama cada noticia antes de enviar. `sending`, `uncertain` y `rejected`
no se liberan automáticamente. Un lote envía solo las noticias cuyos reclamos
posee; si la escritura tras Telegram falla, permanece bloqueado. El grupo opcional
conserva la copia íntegra preexistente, incluida la watchlist, después del acuse
privado. Es secundario, sin reintento automático ni reclamo propio. Las cuotas
cuentan noticias del destino principal, no copias al grupo ni agenda/resumen.

| Ajuste | Recomendación inicial |
|---|---:|
| `NEWS_DELIVERY_MODE` | `two-level` |
| `BRIEF_NEWS_THRESHOLD` / `ALERT_THRESHOLD` | 5 / 7 |
| `WATCHLIST_IMPORTANT_THRESHOLD` | 6 |
| `BRIEF_NEWS_PER_HOUR` / `BRIEF_NEWS_PER_DAY` | 6 / 24 (producción: 48 desde el 15-09) |
| `IMPORTANT_NEWS_PER_HOUR` / `IMPORTANT_NEWS_PER_DAY` | 3 / 12 |
| `BRIEF_BATCH_SIZE` / `BRIEF_INTERVAL_MINUTES` | 3 / 60 |
| `BRIEF_QUIET_HOURS` / `NEWS_TIMEZONE` | `0-8` / `Europe/Madrid` (`none` lo apaga) |
| `BRIEF_MAX_AGE_HOURS` | 12, medidas al llegarle el turno al breve |
| `MAX_PENDING_HOURS` | 48 desde primera captura |
| `AI_CALLS_PER_DAY` | 120 peticiones, incluidos reintentos |
| `MAX_SCORING_PER_CYCLE` / `MAX_DEEP_PER_CYCLE` | 12 / 3 |

Hora: ventana móvil de 60 minutos. Día: calendario UTC. Las reservas preceden la
red y cuentan incluso si el intento no acaba enviado; son conservadoras. Un lote
se reduce si solo queda parte del cupo. Los intentos siguientes reservan de nuevo,
para que una reserva de ayer no salte la cuota de hoy. El aplazamiento registra
motivo y siguiente instante orientativo; no programa un disparador. A las 48 h se
registra expiración. Caducar no borra el historial ni lo enviado.

Horas de silencio: de 00:00 a 07:59 en Madrid los breves no reservan cupo ni se
envían; quedan pendientes con `deferred_quiet_hours` y el fin del silencio como
siguiente instante, y salen después a 3 por hora. Los importantes no se callan.
Motivo: el 15-09 el cupo se reinició a las 02:00 de Madrid y la cola de la noche
lo gastó entero antes de las 10:04. Con 16 horas activas a 3 por hora caben 48
breves, que es el cupo diario de producción.

Frescura en el reparto: un breve al que le llega el turno con más de
`BRIEF_MAX_AGE_HOURS` de publicado **no se envía**. Se cierra con
`stale_at_delivery`, suelta `delivery_pending` y queda `undeliverable` en la
máquina de entrega: la fila sigue entera en la cola, con su motivo al lado, y
`alerts` sigue significando lo que salió de verdad. No se borra nada, entre otras
cosas porque la fila es la memoria de deduplicación: sin ella, la misma noticia
vuelve a entrar en la siguiente captura.

La edad es la de la noticia, por `observed_at`, y la mide `recientes()`, la misma
función que decide la frescura en la captura: "edad de la noticia" significa lo
mismo en los dos sitios. Los importantes no se cortan, igual que no se callan de
noche.

Motivo: `MAX_ITEM_AGE_HOURS` (72) corta al **capturar**, y entre capturar y
repartir hay una cola. El 16-09 esa cola iba casi dos días por detrás —83 breves
esperando, de los cuales 76 de días anteriores— y lo que entraba fresco salía de
anteayer. Doce horas es el número que mantiene el cierre americano de ayer
—22:00 en Madrid— dentro del primer reparto de la mañana, a las 08:04.

## Comparación reproducible

Referencia previa guardada antes del cambio en `test/fixtures/baseline-interest-20260910/`
(hashes en su manifiesto). Es el estado de trabajo con cola del hito anterior,
no se confunde con el commit remoto. La evaluación usa las mismas entradas y
puntuaciones simuladas para ambos sistemas; las etiquetas son propuestas por el
agente, nunca salidas del modelo tomadas como verdad. Todas las etiquetas del
usuario siguen a null. Los patrones públicos y las pruebas previas son calibración;
no se añadieron a las reglas patrones del conjunto reservado.

`npm run evaluate:news` reproduce 12 ejemplos de calibración y 16 reservados.
Los resultados por noticia y motivos están en `evaluacion/dos-niveles.json`.
La muestra pública de 386 entradas queda aparte en `evaluacion/muestra-publica.json`
y 12 ejemplos tienen etiquetas manuales razonadas en `evaluacion/etiquetas-publicas.json`.

| Reserva sintética (16) | Antes | Después |
|---|---:|---:|
| Útiles que alcanzan algún destino | 6 de 11 | 11 de 11 |
| Útiles omitidas por reglas | 5 | 0 |
| Ruido admitido | 3 | 1 |
| Breves: precisión / recuperación | 0 % / 0 % | 85,7 % / 100 % |
| Importantes: precisión / recuperación | 50 % / 25 % | 100 % / 100 % |
| Breves propuestos | 1 | 7 |
| Importantes propuestos | 2 | 4 |
| Solo resumen/dashboard | 6 | 1 |
| Scorings estimados | 9 | 12 |
| Penalización ponderada | 24 | 1 |

Penalización: 5 por importante irrelevante, 5 por material watchlist sin nivel
importante, 1 por otras asignaciones incorrectas. La reserva tiene solo cuatro
importantes: **100 % aquí no acredita 100 % en producción**. El falso positivo
es una frase condicional sobre producción, que recibiría breve con el scoring
simulado. Se mantiene visible, sin ajustar retrospectivamente la reserva.

Agrupación controlada: cuatro entradas representan tres historias (una copia,
un cambio numérico y otra entidad). Antes dejaba dos historias; ahora conserva
las tres. No es una estimación de la tasa real de duplicados.

En la foto pública del 10-09 a las 12:11 UTC hay 116 entradas de hasta 72 h:
53 admitidas antes y 41 ahora; **3 recuperadas y 15 retiradas**. Las recuperadas
incluyen financiación y ampliación de crédito sin watchlist. Se retiran charlas,
hipótesis y algunas piezas mixtas. No se atribuye toda retirada a ruido: las
etiquetas señalan pérdidas de contexto que siguen abiertas. Esa foto incluye
fuentes aún desactivadas, no es un día típico ni demuestra precisión del modelo.

## Capacidad, gasto y almacenamiento

La cadencia observada fue 11 ejecuciones programadas/24 h, no las 48 solicitadas:
132 plazas teóricas de scoring con cupo 12. Con el nuevo presupuesto total 120,
si se emplean 24 intentos profundos quedan como máximo **96 scorings/día**.
Con 48 ciclos y el mismo presupuesto siguen quedando 96, no 576. La cadencia
afecta además a latencia y a elementos desaparecidos antes de capturar.

Supuestos de estimación, no consumos medidos: 1.000 tokens de entrada y 180 de
salida por scoring; 2.500/1.200 por intento profundo. Precio estándar consultado
el 10-09-2026: Haiku 4.5, 1/5 USD por millón entrada/salida; Opus 5, 5/25 USD.
No se usan los precios reducidos de Batch. [Tarifas del proveedor](https://platform.claude.com/docs/en/about-claude/pricing).

| Escenario | Llamadas scoring / profundas | USD/día | USD/30 días |
|---|---:|---:|---:|
| Moderado | 80 / 8 | 0,492 | 14,76 |
| Intenso dentro de 120 | 96 / 24 | 1,2024 | 36,07 |

Fórmula: suma de `(entrada × precioEntrada + salida × precioSalida) / 1.000.000`.
No incluye impuestos, cambio a euros ni diferencias del consumo real. El máximo
1024/8000 tokens de salida por solicitud significa que el techo de llamadas
**no es un techo monetario fijo**. No se ha gastado saldo en esta tarea.
En las condiciones simuladas del holdout: antes 9 scorings y 2 análisis,
0,1021 USD; después 12 y 4, 0,1928 USD, sin reintentos. Es cobertura adicional
con mayor carga, no una promesa de ahorro absoluto.

Con lotes llenos: hasta 8 mensajes breves y 12 importantes/día. Con lotes pequeños,
el techo conservador es 24 mensajes breves + 12 importantes. Añadir agenda/resumen
independientes y copias al grupo si se configuran. Son techos, no objetivos.

Reserva estimada: cola 3-8 KB/ID y decisión/índices 1-3 KB/ID: **4-11 KB/ID**.
100 IDs/día: 12-33 MB/30 días; 500: 60-165 MB. Telemetría, 120 filas/día a 0,5-1 KB:
1,8-3,6 MB/30 días adicionales. `events`, análisis, WAL y versiones de PostgreSQL
se suman. No hay purga automática: revisar consumo, retención y límites del plan
antes de escalar. La caducidad funcional no libera almacenamiento.

## Verificación y procedimientos

Resultado final local: **621 pruebas en 40 archivos, todas correctas**, y
TypeScript sin errores. Además, 10 escenarios de cola y 7 de control/destinos
verificados con PostgreSQL real en WASM. Los [ejemplos ficticios de Telegram](evaluacion/ejemplos-telegram.md)
se generan con los formateadores reales: 281 caracteres el breve y 924 el importante.
No se ha creado un PDF, siguiendo la última indicación del usuario.

Durante el trabajo apareció en el historial el guardado de sesión `f0e0ee2`,
fechado a las 15:39:55 +02:00. No procede de un comando de commit ejecutado en
esta tarea y no se ha revertido ni reescrito. Hay cambios posteriores a ese guardado.

Pruebas sin servicios reales: `npm run typecheck`,
`npx vitest run --pool=threads --maxWorkers=3`, `npm run verify:queue:postgres`
y `npm run verify:control:postgres`. PGlite se prepara como describe
`scripts/verificar-cola-postgres.ts`; no es dependencia de producción.
Comprueban reinicio con excedentes fuera del RSS, duplicados tardíos, fallo parcial,
justicia por editor, cuotas, expiración, degradación, consumo y no reenvío incierto.
PostgreSQL WASM valida SQL y estados; no simula dos conexiones de Neon.

**Activación futura, no ejecutada:**
1. Conservar backup y detener consumidores durante la transición. Aplicar por el
   procedimiento existente las migraciones pendientes, incluida cola, entregas
   y `20260910_news_control.sql`, antes de desplegar también el dashboard/resumen.
2. Primera prueba autorizada con `MONITOR_MODE=capture-only`; pausar Agenda y
   consumidores independientes si se exige cero envíos. Verificar acuses de captura.
3. Comparar diagnóstico y seleccionar `two-level`. Para probar sin gastar, mantener
   `AI_CALLS_PER_DAY=0`; esto no bloquea el envío de puntuaciones previas, por lo
   que la ventana sin Telegram requiere `capture-only`.
4. Activar tanda 1, observar 24-48 h, después tanda 2. Comprobar que `RSS_FEEDS`
   explícito no anula las tandas. No activar las fuentes bloqueadas.
5. Cuando se autorice, habilitar procesamiento y envío con cuotas; verificar
   noticias reales, precisión, gastos, grupo, resumen y reclamaciones multisesión.
6. El disparador externo tiene su guía propia; no se ha registrado ni entregado token.

**Reversión:** `MONITOR_MODE=capture-only` detiene IA y Telegram del monitor sin
perder capturas. `NEWS_DELIVERY_MODE=legacy` recupera la política de entrega antigua,
pero también deja de aplicar las nuevas cuotas/telemetría de IA; usarlo con los
consumidores parados y decisión explícita, no como garantía de gasto. Las reglas
y cola nuevas permanecen. Volver todo el código a una versión previa es otra
operación y recuperaría sus limitaciones. No borrar tablas aditivas, reclamos ni
pendientes. Volver a `RSS_FEED_BATCHES=core` detiene incorporaciones futuras, pero
no elimina la cola existente. Un envío incierto requiere investigación, nunca
`--force` automático. `npm start -- --dry` puede llamar a IA: no es prueba gratis.

**Pendiente:** preferencias personales, migración/despliegue autorizados, calidad
real de traducción y scoring, cadencia sostenida, concurrencia multisesión,
entrega y recepción reales, validación de condiciones antes de fuentes bloqueadas,
retención y coste medido. La presencia de código o un workflow verde no demuestra
que estos puntos estén resueltos.
