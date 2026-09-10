# Captura persistente: entrega local del 10 de septiembre de 2026

> Hito previo. La política posterior de [dos niveles](dos-niveles-noticias.md)
> añade caducidad configurable a 48 h, decisiones por destino y presupuesto diario.
> Sus reglas sustituyen el pase automático por procedencia oficial descrito aquí.

Los cinco hitos están preparados en este repositorio. **La migración y la nueva versión no se han aplicado en producción.** No se han hecho commits, despliegues, escrituras en Neon, envíos de Telegram, registros de servicios ni llamadas a modelos. Las verificaciones de fuentes son GET públicos; la cadencia se consulta en lectura.

## 1. Capturar antes de limitar

Cada fuente guarda sus eventos normalizados en `capture_queue` en cuanto termina. La captura incluye las noticias que las reglas o la frescura descartan, con motivo. El cupo limita las puntuaciones posteriores. Una fuente que acaba después o falla no elimina los lotes ya guardados.

| Estado | Significado | Recuperación |
|---|---|---|
| `pending` | Capturada y admitida por reglas | Espera su turno, aunque desaparezca del RSS |
| `processing` | Un proceso posee temporalmente la puntuación | Lease de 15 minutos por defecto; después es reclamable |
| `scored` | Resultado completo del modelo guardado | No se vuelve a puntuar; finaliza proyección y, si procede, entrega |
| `discarded` | Descarte con motivo persistente | No se reactiva por volver a capturar el mismo ID |
| `retryable_failed` | Falló la puntuación | Reintento desde 1 minuto, duplicando la espera hasta 6 horas |

Los motivos distinguen antigüedad inicial, reglas sin coincidencia, bajo contenido informativo, historia duplicada y evento procesado por la versión anterior. Una puntuación inferior al umbral sigue siendo `scored`: se conserva la nota que explica por qué no alertó. No es un fallo.

La clave única es el ID normalizado. Repetir capturas suma apariciones y actualiza la última captura; conserva el contenido inicial, el estado y la primera captura. «Únicas» significa IDs únicos, no historias únicas: dos editores pueden aportar dos IDs que después se agrupen como una historia.

`SeenStore.has` sigue consultando el registro **procesado** `events`. La captura se almacena en otra tabla y jamás llama a `seen.mark`. No se convierte una fila recién capturada en un evento procesado. Los registros anteriores se reconocen y se descartan en la cola con `legacy_processed`, sin repuntuarlos.

Las fechas están separadas:

- `publication_at`: publicación original del comunicado o noticia. Null cuando solo se conoce una actualización.
- `first_captured_at`: primera captura inmutable de la cola. Se conserva al proyectar `events.first_seen_at`.
- `retrieved_at` y `last_captured_at`: descarga original del snapshot y última aparición observada.
- `data_period_at`: periodo del dato estructurado macro. No se inventa a partir del día de publicación. En RSS queda desconocido si el periodo solo aparece en prosa.

La frescura se aplica **al entrar**, usando publicación cuando el feed la ofrece. No vuelve a excluir un pendiente que ha esperado más de 72 horas. Por ello, la fecha debe seguir visible al valorar una noticia atrasada. La cola no puede recuperar artículos que desaparecieron del RSS antes de que hubiera una sola captura.

## 2. Capacidad, agrupación y entrega

El escaneo toma hasta 500 pendientes reclamables, repartidos por editor y empezando por los más antiguos de cada editor. Así, un editor con 510 pendientes no oculta a otro que tiene uno. El plan agrupa noticias compatibles y distribuye rondas de una plaza por editor; tres feeds BLS, dos BoE o cinco Investing comparten editor.

La prioridad es auditable: 4 puntos para dato macro o relación con la watchlist; 3 para noticias con señales materiales; 1 para otras noticias; 0 para comunicados oficiales rutinarios. Se suma **un punto por cada seis horas esperando**, sin techo. Una fuente oficial por sí sola no da puntos. Las rutinas oficiales ocupan como máximo un cuarto del cupo mientras queden otras noticias; si solo quedan rutinas, pueden usar la capacidad disponible. Es una heurística, no una valoración económica del modelo.

Los motivos, editor, puntuación base y puntos por espera aparecen en la auditoría privada. Los logs de Actions solo publican vocabulario cerrado y contadores. El escaneo es acotado: una noticia recién capturada puede esperar detrás del histórico pendiente de su propio editor. La antigüedad y el tamaño de la cola hacen visible esa presión.

La agrupación conserva el umbral 0,6 y añade dos guardas: publicaciones separadas por más de 24 horas y titulares con cifras distintas no se fusionan. Un recorte de 25 puntos no oculta uno de 50. Antes de reclamar se consulta el contexto persistido de noticias de ±24 horas, incluidas puntuadas y copias descartadas, sin el corte de 500. Así se reconocen tanto una copia fuera del escaneo como otra que llega en un RSS posterior. `story_at` indexa esa consulta; no inventa la publicación original. Un grupo se reclama completo o no se reclama; representante puntuado y copias descartadas se guardan en una transición atómica.

El resultado del scoring se guarda antes de finalizar. `delivery_pending` significa **finalización pendiente**: incluye proyectar una puntuación bajo umbral en `events`, además de las posibles alertas. Si falla esa proyección, faltan credenciales o falla el análisis antes del reclamo, la puntuación sigue disponible para reanudar sin volver a llamar al modelo de scoring. Las finalizaciones anteriores se atienden antes de puntuar novedades, para que un ciclo lento no las posponga indefinidamente. Cada entrada se intenta una sola vez por vuelta. Si falta la clave del modelo, una nota ya guardada puede entregar su versión corta sin análisis nuevo.

`alert_deliveries` mantiene sus reclamos exclusivos. `sending`, `sent`, `rejected` y `uncertain` no caducan ni se liberan por una lease de puntuación. La recuperación consulta el reclamo antes de repetir análisis. Un `sent` confirmado cierra la finalización pendiente sin un aviso de fallo falso. En local, `alert-deliveries.json` conserva esa misma protección entre procesos y reinicios. La copia secundaria al grupo mantiene su comportamiento previo; no añade un reintento autónomo.

`--force` sigue siendo una petición explícita de reenvío de la captura actual y usa una cola efímera. No borra ni reabre el backlog. No se utiliza para reparar huecos de captura.

## 3. Fuentes y filtros

[El catálogo de cobertura](fuentes-cobertura.md) contiene endpoints, condiciones oficiales, atribución, región, idioma, fechas, muestras y reversión por tanda. Preparadas: BLS empleo/IPC/PPI y EIA Today in Energy en `batch1`; BoE News/Publications y BoJ en `batch2`. El defecto conserva `core` con ocho feeds.

Investing divisas y materias primas están registradas como candidatas desactivadas hasta resolver sus condiciones. No duplican economía, indicadores ni bolsa. EIA semanal queda desactivada por fechas inválidas e histórico antiguo. Un ID explícito en `RSS_FEEDS` tampoco salta `enabled: false`.

No se ha bajado el umbral de alerta. Sobre la misma muestra pública, los filtros recuperan cuatro candidatas antes omitidas: libra/BoE, Brent/transporte, producción OPEC y oro/rendimientos del Treasury. Divisas pasa de 7 a 8 de 10; materias primas, de 2 a 5 de 10. Siguen fuera los niveles técnicos y las menciones genéricas sin señal. Pasar reglas significa poder puntuarse, no enviar Telegram.

## 4. Concurrencia y EDGAR

Por defecto hay tres fuentes en paralelo, 45 segundos por fuente y 180 segundos de plazo global de recolección. La cancelación llega al HTTP y a sus reintentos. La escritura temprana es serial y esperada; un fallo de persistencia aborta visiblemente, no se presenta como un RSS caído.

EDGAR separa cada empresa. Un fallo de resolución o descarga no pierde documentos de otras. Lee Submissions y filtra formularios antes del máximo de 1.000 relevantes; puede consultar hasta dos archivos históricos cuando `recent` no cubre la ventana solicitada. Declara cobertura incompleta si trunca o falla un archivo, conservando los documentos válidos. El límite es de 150 ms entre intentos SEC, también reintentos, por proceso; otros consumidores de la misma cuenta/IP también deben respetar el límite agregado del editor. [Documentación SEC](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [acceso a EDGAR](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data).

## 5. Medición y cadencia

`QUEUE_CAPTURE` mide apariciones e IDs nuevos del lote confirmado. `QUEUE_STATS` mide acumuladas, únicas, pendientes, en proceso, fallidas reintentables, puntuadas, descartadas, procesadas, finalizaciones pendientes y edad máxima, por fuente. `QUEUE_DISCARDED` desglosa motivos. Pendientes incluye reintentos todavía no vencidos; el plan solo muestra lo reclamable. Las estadísticas cubren toda la cola, no solo las 500 filas del plan.

Comandos de lectura:

```powershell
npm run audit:queue
npm run audit:queue -- --detalle
npm run audit:filters -- --detalle
npm run audit:cadence
```

La auditoría de filtros simula el RSS visible contra los eventos procesados; no sustituye la auditoría de backlog. Los detalles con titulares, URLs o watchlist solo se escriben en `.cache/`, ignorada por Git, y se prohíben en Actions. Si falta `capture_queue`, el auditor falla: no muestra una cola vacía inventada.

La lectura de Actions a las 12:19:50 UTC dio **11 programados de 48 previstos en 24 horas (22,92 %)**, todos exitosos. Se excluyen dos manuales exitosos y uno cancelado. El mayor hueco entre programados observados fue de 185,4 minutos. El borde izquierdo sin ejecución observada supera cinco horas, pero está censurado por la ventana. Los campos de inicio coinciden con creación y no prueban cuándo comenzó la captura real. [Evidencia y procedimiento del disparador externo](disparador-externo.md).

## Pruebas reproducibles y límites

Verificación completa del 10 de septiembre: **598 pruebas aprobadas en 39 archivos**, typecheck correcto y **10 escenarios SQL locales aprobados**. `git diff --check` también pasó. Las pruebas de ciclo usan datos sintéticos y servicios doblados; no son una ejecución de producción.

```powershell
npm run typecheck
npx vitest run --pool=threads --maxWorkers=4
npm run verify:queue:postgres
```

El último comando requiere preparar PGlite 0.5.8 dentro de `.cache/`, siguiendo la cabecera de `scripts/verificar-cola-postgres.ts`. Es un motor PostgreSQL local en WASM, sin `.env`, Neon ni servicios. No se añade una dependencia de producción. Su informe queda en `.cache/verificacion-cola-postgres.json`.

| Caso | Evidencia local |
|---|---|
| 31 capturadas, cupo 12, reinicio, RSS vacío | 19 snapshots pendientes; se consumen incluso cuatro días después |
| Recaptura repetida | 31 IDs únicos y exactamente 31 puntuaciones simuladas, sin reiniciar resultados |
| Caída parcial | Una fuente/empresa falla y las demás persisten; fallo al guardar se propaga |
| Reparto justo | Varios feeds de un editor, seis instituciones rutinarias y escaneo de 510+1 pendientes |
| Muerte tras puntuación o reclamo | Reanuda proyección sin rescoring; no reenvía un `sending` |
| Copias fuera del escaneo o en un RSS posterior | Una sola puntuación y finalización por historia reconocida |
| Dos procesos locales | Un solo reclamo de Telegram; ledger durable y corrupción que falla cerrado |
| SQL real | Migración idempotente, transiciones de grupo, leases, backoff, métricas y constraints en PGlite |

Los servicios, modelos y Telegram se sustituyen por dobles en los tests de ciclo. Los tests de archivos sí escriben y reabren archivos reales dentro de `.cache/`. PGlite valida SQL real en diez escenarios, pero es monoconexión: **no verifica contención entre sesiones reales de Neon ni latencia del driver remoto**. Eso queda pendiente de una activación autorizada en un entorno de prueba. No se ha ejecutado `npm start -- --dry`: ese modo sigue pudiendo gastar en modelos.

## Impacto estimado

No se sube el cupo: hasta 12 solicitudes de scoring por ciclo. El SDK no reintenta por su cuenta; los fallos pasan a la cola. Hasta tres análisis profundos por ciclo, con hasta dos solicitudes cada uno por el control de cifras ya existente. Presupuesto máximo teórico de scoring: **576/día con 48 disparos**, frente a **132/día si se mantuvieran 11**. Son techos, no previsiones de consumo ni garantía de puntualidad. No se ha hecho una llamada facturable para estimarlos.

Las dos tandas oficiales añaden siete GET RSS y unos 98 KB transferidos por ciclo en la muestra: aproximadamente 4,7 MB/día a 48 ciclos, más las fuentes existentes. La muestra añadida contiene 197 entradas históricas y unos 122 KB de JSON normalizado. Los históricos descartados se guardan una vez; las siguientes capturas actualizan contadores, no crean otra fila.

Para la cola, reservar inicialmente **3–8 KB por ID único** con snapshot, estado e índices da este orden de magnitud:

| Nuevos IDs por día | Crecimiento de cola en 30 días |
|---:|---:|
| 100 | 9–24 MB |
| 500 | 45–120 MB |

No incluye WAL, versiones muertas pendientes de vacuum ni el contenido adicional de `events`/`alerts`. Es una reserva, no una medición de Neon. La muestra sintética PGlite de 544 filas ocupa 532.480 bytes con índices, pero sus snapshots medios son de solo 469 bytes y no representan todos los resúmenes reales. La primera tanda completa de 197 entradas supone aproximadamente 0,6–1,6 MB usando la reserva conservadora.

El procesamiento sostenible exige que entradas admitidas y no agrupadas sean menores que `disparos reales × cupo`. Si crecen pendientes y edad máxima, ampliar fuentes agrava el retraso aunque todos los jobs estén verdes. La entrega guardada evita volver a pagar scoring por fallos posteriores; no elimina el coste de procesar noticias adicionales antes perdidas. Las recapturas siguen produciendo escrituras de contadores. Hay una escritura SQL por lote de fuente y consultas adicionales por grupo para contexto, reclamo, resultado y finalización; el contexto de historias usa un índice temporal y puede superar 500 filas. Medir tamaño, actividad y cuota del proveedor tras activar; no se ha contratado capacidad adicional.

No hay borrado automático. Una política futura de retención debe conservar pendientes y tombstones de IDs procesados/descartados, para que una reaparición no duplique trabajo.

## Activación futura, por pasos

Estos pasos son instrucciones para una operación posterior, **no acciones ejecutadas en esta entrega**.

1. Revisar el diff y ejecutar las pruebas. Guardar una copia del estado y parar consumidores antes de cambiar versión/esquema. Mantener los registros existentes de entrega.
2. Probar `20260910_capture_queue.sql` en un PostgreSQL de ensayo; verificar dos consumidores reales en paralelo, caída/reinicio y lecturas de métricas. Después aplicar esa migración al destino autorizado. Es aditiva y no altera ni borra `events` ni `alert_deliveries`. El migrador general aplica todas las migraciones: revisar esa lista antes de usarlo.
3. Publicar la versión revisada y empezar con `MONITOR_MODE=capture-only`, `RSS_FEED_BATCHES=core`. Este modo escribe la cola sin modelos ni Telegram. El workflow preparado desactiva su aviso de fallo y el resumen reconoce `Monitor (capture-only)` para no generar agenda/resumen indirectamente. El modo global de captura también bloquea el resumen independiente. **Pausar Agenda durante esta validación aislada:** su cron propio sigue siendo independiente de Monitor. Comprobar IDs únicos, estados, fechas, motivos, grupos y reparto mediante `audit:queue`.
4. Cuando se autoricen procesamiento y envíos, cambiar a `MONITOR_MODE=full`; mantener 12/3. Verificar que disminuye el backlog, se conservan puntuaciones y no aparecen envíos duplicados. `process-only` permite consumir la cola sin volver a recolectar. Una falta de Telegram deja finalización pendiente.
5. Activar `core,batch1`, observar al menos un día y un comunicado BLS real. Solo después activar `batch2` con la misma revisión. Los candidatos bloqueados no se habilitan. Comprobar que `RSS_FEEDS` no está anulando la selección de tandas.
6. Registrar el disparador externo únicamente cuando se autorice y siguiendo su documento. No entregar un token en este repositorio, la conversación ni logs. Medir tanto aceptación del disparo como finalización del workflow y capturas confirmadas.

## Reversión y recuperación

- Para detener modelos/envíos de Monitor y conservar captura: `MONITOR_MODE=capture-only`. Revisar y pausar también Agenda y cualquier consumidor independiente si se necesita una ventana sin ningún envío. Para detener toda escritura: parar los disparadores y los consumidores en marcha.
- Para reducir cobertura: volver a `RSS_FEED_BATCHES=core` y retirar IDs nuevos explícitos. Esto no cancela candidatos ya guardados. No vaciar tablas para simular una reversión.
- Para volver al código anterior: parar consumidores primero, conservar copia de `capture_queue` y todos los reclamos de entrega, desplegar la versión conocida y documentar que vuelve a perder excedentes. El código anterior no drena esta cola; no ejecutar ambos consumidores juntos. No hace falta eliminar la tabla aditiva.
- Para recuperar un bloqueo local huérfano: parar todos los procesos, conservar copia del JSON, comprobar que el dueño no está activo y retirar únicamente `queue.json.lock` o `alert-deliveries.json.lock`. Nunca borrar el ledger ni retirar bloqueos mientras haya consumidores. Los bloqueos no caducan automáticamente.
- Ante `sending` o `uncertain`, revisar el registro y el destino. No usar `--force` ni liberar por tiempo como reparación automática. La política sigue prefiriendo declarar una entrega incierta a enviar dos veces.
- Para retirar el disparador externo: desactivar su tarea y revocar su token restringido. El cron interno puede quedar como respaldo; conservar las métricas para comprobar la cadencia restante.

Pendiente en producción: migración, despliegue, prueba multisesión, activación de tandas, precisión de filtros/agrupación durante varios días, tamaño y consumo reales, y puntualidad del disparador externo.
