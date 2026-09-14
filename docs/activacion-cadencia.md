# Registro de activación de cadencia

**Traspaso a Claude, 10-09-2026 17:47 Madrid:** ver
[traspaso-a-claude.md](traspaso-a-claude.md). El seguimiento de Codex se ha pausado
y su escucha temporal se ha detenido. Worker y Monitor permanecen en captura sin
procesamiento.

**Continuación, 18:05 Madrid:** el dispatch externo sigue sin producirse y ya no
cabe achacarlo a la propagación. Cuatro slots del cron pasaron en blanco y la
escucha anterior no vio ninguna invocación del Worker. La captura persistente, en
cambio, está verificada. Detalle en [la comprobación de Claude](#comprobación-de-claude-10-09-1805-madrid-1605-utc).

Inicio: 10-09-2026. Este registro continúa la implementación local descrita en
[cadencia-cloudflare.md](cadencia-cloudflare.md). Los resultados de aquella fase
siguen en [verificacion-cadencia.md](verificacion-cadencia.md).

## Estado a las 17:39 de Madrid

- GitHub: acceso de escritura comprobado; rama predeterminada `main`, remota en
  `a1b161d` antes de publicar. Publicado el conjunto autorizado en **`f1c1e65`**.
  Monitor reactivado en capture-only; Agenda y Resumen pausados durante la
  observación; Latido conserva su estado. Estados originales guardados en
  `.cache/activation-remote-settings-before.json`.
- Variables relevantes `MONITOR_MODE`, `NEWS_DELIVERY_MODE`, `RSS_FEED_BATCHES`,
  `RUN_TELEMETRY` y `AI_CALLS_PER_DAY`: no estaban configuradas. Para observar se
  han establecido `MONITOR_MODE=capture-only` y `RUN_TELEMETRY=true`.
- Neon: conexión de lectura correcta. Existen `events` y `alert_deliveries`.
  Las tres migraciones pendientes se aplicaron en una transacción a las
  **15:23:13 UTC**. Se verificaron `capture_queue`, `news_usage`, `news_decisions`,
  `monitor_runs` y `monitor_event_timing`. No se ejecutó el monitor durante la migración.
- Entregas: 14 reclamos en estado `sent`; último acuse a las **14:20:37 UTC**
  del 10-09. Esto acredita que hubo una entrega; no acredita puntualidad ni que
  todas las noticias importantes se hayan enviado. La tarea no provocó ese envío.
- Cloudflare: Wrangler autorizado por Alberto; una cuenta disponible. El código
  de `news-monitor-clock` se ha subido, con `ENABLED=false`, `fast-only` y
  `capture-only`, sin rutas públicas.
- Los primeros despliegues fueron parciales por el error `10063`. Alberto abrió
  Workers & Pages en la cuenta correcta y se resolvió. **Cron registrado**:
  `3,13,23,33,43,53 * * * *`; versión `6c100c30-7c62-4ac2-83de-c69e068d4aed`.
  Alberto cargó `GITHUB_TOKEN`; comprobada su existencia como `secret_text`, sin
  leer el valor. Worker **activado en fast-only/capture-only** mediante
  `wrangler deploy --var ENABLED:true`; versión `0a109b3f-d942-4412-9dd5-e3b4483e4213`.
  El archivo versionado conserva `ENABLED=false` como valor seguro: una futura
  publicación sin el override apagará el reloj. Aún se espera evidencia del primer
  dispatch automático; el cron recién creado puede tardar en propagarse.

## Primera captura real sin procesamiento

[Ejecución 34495563870](https://github.com/seeorr/news-monitor/actions/runs/34495563870):
`fast`, `capture-only`, origen manual. Final de Actions a las **15:26:06 UTC**,
correcto. El proceso registró inicio 15:26:00.082 y fin 15:26:03.834 UTC.

- 84 apariciones, 79 únicas; 10 pendientes y 69 descartadas.
- Tres fuentes correctas, cero fallidas; BCE y Fed entre las correctas.
- Cero puntuaciones y cero envíos en la ejecución.
- `news_usage` vacía. El ledger mantiene los mismos 14 acuses y su última fecha
  anterior: no hubo un envío nuevo durante la prueba.
- Evidencia agregada local: `.cache/activation-first-fast.json`.

La segunda ejecución `full / capture-only`,
[34495721148](https://github.com/seeorr/news-monitor/actions/runs/34495721148),
terminó correctamente a las **15:27:59 UTC**: 21 fuentes correctas, cero fallidas,
181 apariciones y 100 nuevas únicas. La cola pasó de 10 a 31 pendientes. BCE y Fed
mantienen sus filas y primera captura, aumentando las apariciones sin duplicar
filas. `news_usage` sigue vacía y el ledger conserva los mismos 14 acuses. Se han
comprobado además los 12 índices de los nuevos módulos y la función de presupuesto.

Estos son tiempos reales de ejecución/captura, pero no miden el objetivo de una
publicación nueva: los feeds contienen noticias anteriores. El informe de salud
de arranque declaró retraso antes de completar full y por noticias históricas
capturadas durante el arranque. No se oculta esa diferencia ni se envía el backlog.

Revisión inicial del backlog: la decisión BCE de las 12:15 sigue pendiente sin
entrega por su propio id. La declaración de las 13:00 ya tiene un acuse de entrega
previo. Antes de habilitar procesamiento se debe resolver ese caso y las copias de
prensa, respetando la instrucción de no reenviar retrospectivamente el incidente.
No se han liberado reclamos, fabricado entregas ni alterado fechas para saltarlo.

Se creó el seguimiento temporal de esta tarea **Observar activación de News
Monitor**, ahora **pausado para el traspaso a Claude**. Su plan era cada 15 minutos
y un máximo de nueve comprobaciones. Solo lee el
estado remoto y actualiza esta documentación y la ficha. Evaluará la observación
tras al menos dos horas desde las 17:31 de Madrid y se pausará al emitir el
informe final. No habilita procesamiento ni envíos. Si la captura sin procesamiento
supera dos horas, `aged_queue` puede ser el resultado esperado de esta ventana:
debe declararse, sin liberar pendientes ni confundirlo con un fallo del reloj.

## Revisión preparada

La referencia local anterior era `037e77a`. Se publicaron tres commits previos:
`9ef925e` (protección del dashboard), `f0e0ee2` (cola, control, cobertura y pruebas)
y `037e77a` (evaluación), junto con `f1c1e65` (cadencia). Alberto autorizó
expresamente el conjunto. Los dos archivos que ya tenía modificados se conservaron
fuera del nuevo commit; sus hashes coinciden con la referencia inicial.

Los cambios previos sin commit de `docs/dos-niveles-noticias.md` y
`scripts/evaluar-noticias.ts` se conservan y quedan fuera del nuevo commit.
Manifiesto local de 205 archivos con SHA-256:
`.cache/activation-release-manifest.json`. Diff de cambios ya seguidos, excluidos
esos dos archivos: `.cache/activation-review.diff`. Los archivos nuevos constan
en el manifiesto; el diff por sí solo no constituye el paquete completo.

Escaneo final del árbol: 205 archivos, cero coincidencias de patrones de
credenciales. Es una comprobación heurística; no imprime valores de secretos.

## Migración aplicada y verificada

Orden exacto:

1. `20260910_capture_queue.sql`: 5 sentencias.
2. `20260910_news_control.sql`: 7 sentencias.
3. `20260910_run_cadence.sql`: 5 sentencias.

Plan local: `.cache/apply-cadence-migrations.ts`, por defecto solo muestra el
plan. La rama de ejecución explícita usa una transacción para las 17 sentencias,
comprueba sus hashes, exige los objetos previos y aborta si detecta que alguien
ha creado ya los módulos nuevos. No reejecuta el migrador general. Antes de
ejecutar se confirmó que el estado remoto continuaba siendo el observado. Resultado
en `.cache/activation-migrations-result.json`. No volver a ejecutar ese plan contra
el esquema ya migrado: su guardia debe rechazarlo.

## Comprobación de Claude, 10-09 18:05 Madrid (16:05 UTC)

Continuación del traspaso. Todo lo de abajo es lectura; no se ha desplegado,
migrado ni enviado nada.

### El reloj de Cloudflare no está disparando GitHub

Hecho verificado, ya no atribuible a la propagación de 15 minutos que terminó
a las 15:46 UTC:

- Seis slots del cron seguidos —`:33`, `:43`, `:53`, `:03`, `:13` y `:23`, de
  15:33 a 16:23 UTC— pasaron **sin crear ninguna ejecución** en GitHub. La última ejecución del repositorio sigue
  siendo la manual de las **15:27:09 UTC**, anterior a la activación del reloj:
  media hora de reloj activo sin un solo disparo suyo.
- En Neon, `monitor_runs` solo contiene **dos filas, ambas `trigger=manual`**
  (15:26:00 y 15:27:33 UTC). Cero filas `external`.
- La escucha de la sesión anterior (`wrangler tail`, 15:36:21–15:46:56 UTC) cubrió
  el slot `:43` **sin registrar ni una sola invocación**. El Worker escribe un
  registro en todos sus caminos, incluido `disabled` e `invalid_config`, así que
  la ausencia de registros apunta a que el Worker **no llegó a ejecutarse**, no a
  que GitHub rechazara el dispatch. `.cache/clock-observation.json` no existe:
  aquella escucha no capturó nada.

Lo que **sí** está bien y queda descartado como causa:

- `main` remoto sigue en `f1c1e65`; `.github/workflows/monitor.yml` remoto y local
  comparten blob `caad33e`. Los tres `inputs` que envía el Worker —`profile`,
  `origin`, `mode`— están declarados con las opciones que usa, así que un 422 por
  entradas inesperadas queda descartado.
- Variables de Actions: `MONITOR_MODE=capture-only`, `RUN_TELEMETRY=true`.
  Monitor y Latido activos; Agenda y Resumen siguen `disabled_manually`.

**Acceso a Cloudflare, recuperado a las 18:09 Madrid.** Wrangler había perdido sus
credenciales en este equipo: solo quedaban `logs/` y `metrics.json`, sin
`config/default.toml`. No se leyó ningún archivo de credenciales. Alberto reautorizó
con `wrangler login` sobre la misma cuenta `c96b492f…`; ahora vuelven a estar en
`%APPDATA%\xdg.config\.wrangler\config\default.toml`.

Con ese acceso, el despliegue queda descartado como causa:

- Despliegue activo **`0a109b3f` al 100 %**, creado 15:32:04 UTC, autor Alberto.
  Los despliegues previos (`6c100c30` y `2cfbcdd1`, este último al añadir el secreto)
  quedaron atrás; no hay reparto parcial de versiones.
- La versión activa declara **handler `scheduled`**, secreto **`GITHUB_TOKEN`**
  enlazado y las variables correctas: `ENABLED="true"`, `seeorr`, `news-monitor`,
  `monitor.yml`, `main`, `fast-only`, `capture-only`.
- El despliegue de las 15:32 registró los triggers: `3,13,23,33,43,53 * * * *`.

Es decir: **el Worker está bien desplegado, bien configurado y bien apuntado, y aun
así no se ejecuta.**

**Prueba concluyente del slot `:23` (16:23:00 UTC).** Escucha propia conectada y
demostrada viva —55 ping/pong seguidos, ininterrumpidos durante el slot— con este
resultado: **cero invocaciones del Worker y cero ejecuciones nuevas en GitHub**.
Con ella son **seis slots consecutivos** en blanco: 15:33, 15:43, 15:53, 16:03,
16:13 y 16:23 UTC.

El panel de Cloudflare, consultado por Alberto a las 18:2x Madrid, cierra el
diagnóstico desde el otro lado:

- **Cron triggers**: registrado, «At 3, 13, 23, 33, 43, and 53 minutes past…».
- **Next**: `Thu, 10 Sep 2026 16:23:00`, es decir, el horario **avanza bien**.
  Una lectura anterior que parecía congelada en 15:53 era la página sin recargar,
  no un planificador atascado.
- **Observability**: «no events found». Ninguna invocación registrada.

Conclusión: el reloj está **bien configurado y bien registrado, y aun así no se
ejecuta**. No es propagación, ni el despliegue, ni el handler, ni las variables, ni
el secreto, ni el destino en GitHub: todo eso está verificado. Falla que la
plataforma llegue a invocar al Worker.

Siguiente comprobación acordada con Alberto, antes de escribir nada: si la cuenta
tiene **subdominio workers.dev** registrado. El `10063` inicial fue exactamente esa
carencia, y si sigue sin resolverse, recrear el cron no arreglaría nada. Después,
si procede, re-registrar los triggers —`wrangler triggers deploy` aplica solo
triggers, comprobado con `--help` y `--dry-run`, así que no puede devolver
`ENABLED` a `false`— o recrear la entrada desde el panel.

### Reparación intentada: re-registro de los triggers

Subdominio **descartado** como causa a las 18:30 Madrid: la cuenta sí tiene
`aalmendromirat.workers.dev`, con la URL del Worker creada y el interruptor
apagado, que es justo lo que corresponde a `workers_dev: false`. El `10063`
inicial está resuelto.

Con las causas de configuración agotadas, y con autorización expresa de Alberto,
se reaplicaron los triggers a las **16:32:27 UTC**:

```
npx wrangler triggers deploy
→ Deployed news-monitor-clock triggers
  schedule: 3,13,23,33,43,53 * * * *
```

Comprobado antes con `--help` y `--dry-run` que la orden aplica **solo** triggers:
no sube código ni variables. Confirmado después: el despliegue activo sigue siendo
**`0a109b3f`**, creado a las 15:32:04 UTC, sin versión nueva y con `ENABLED` intacto.
Estado previo anotado por si hay que revertir.

El slot `:33` (16:33 UTC) siguió en blanco, pero **no cuenta como prueba**: el
re-registro fue 33 segundos antes y Cloudflare declara hasta 15 minutos de
propagación, que terminan a las 16:47:27. El indicio es `:43` y la prueba limpia
es `:53`.

**Resultado del re-registro: no arregla nada.** Los slots `:43` y `:53` (16:43 y
16:53 UTC) siguieron sin invocación y sin ejecución en GitHub. El `:53` es la
prueba limpia: la ventana de propagación de 15 minutos terminó a las 16:47:27.

La escucha estuvo conectada de forma continua de 16:15 a 16:55 UTC —**234
ping/pong**, cubriendo los slots `:23`, `:33`, `:43` y `:53`— y registró **cero
eventos** del Worker. Con esto son **nueve slots consecutivos** en blanco, de
15:33 a 16:53 UTC.

Estado tras la escritura: despliegue `0a109b3f` intacto, `ENABLED` sin tocar,
ninguna versión nueva. La reparación no dejó residuo que revertir.

**Diagnóstico cerrado por eliminación.** Están verificados y correctos: el
despliegue y su versión activa, el handler `scheduled`, las variables, el secreto,
el destino en GitHub, el workflow y sus `inputs`, el cron registrado, su `Next`
avanzando y el subdominio de la cuenta. Lo único que no ocurre es la invocación.
Es un fallo del lado de la plataforma, no del proyecto.

### Reloj de repuesto: `news-monitor-clock-2`

Con autorización de Alberto, y agotadas las reparaciones sobre el Worker original,
se desplegó a las **16:57:17 UTC** un segundo Worker con el mismo código:

```
npx wrangler deploy --name news-monitor-clock-2 --var ENABLED:true
→ Uploaded news-monitor-clock-2
  Deployed news-monitor-clock-2 triggers
  schedule: 3,13,23,33,43,53 * * * *
  Version ID: eceb0051-8a45-42bb-ac27-2751b5b8f30e
```

Las siete variables se heredaron correctas del `wrangler.json`, con `ENABLED`
sobrescrito a `true` por línea de órdenes, igual que en el reloj original. El
`wrangler.json` versionado **no se ha tocado**: sigue con `ENABLED=false`.

**Se despliega a propósito sin el secreto `GITHUB_TOKEN`.** Es una prueba
deliberadamente inerte: si el cron llega a ejecutarlo, el Worker escribe
`invalid_config` y no llama a GitHub, porque el token es una de las condiciones
que valida antes de salir a la red. Así se distingue lo único que queda por
distinguir, sin efectos y sin pedir el token todavía:

- **Aparece `invalid_config`** → el planificador sí ejecuta el script nuevo; el
  fallo era del Worker original. Entonces sí procede cargar el secreto en el nuevo,
  comprobar que dispara y apagar el viejo.
- **No aparece nada** → el planificador no ejecuta ningún script de esta cuenta.
  El token nunca habría cambiado nada, y toca incidencia en Cloudflare o cambiar
  de disparador externo.

El Worker original queda desplegado y sin tocar. Como no se ejecuta, no hay riesgo
de disparo doble mientras dure la prueba.

### La captura persistente sí funciona

Lectura de Neon a las 15:54:43 UTC, sin ejecutar el monitor:

- `capture_queue`: 179 filas capturadas por primera vez en las tres horas previas.
  31 `pending` (40 apariciones) y 148 `discarded` (225 apariciones). Primera
  captura 15:26:00, última 15:27:54 UTC — es decir, **nada nuevo desde el último
  disparo manual**, coherente con un reloj parado.
- `news_usage` vacía: cero llamadas a modelos. `alert_deliveries` sigue con
  **14 filas `sent`** y último acuse **14:20:37 UTC**, el mismo del traspaso:
  ningún envío nuevo durante la observación. La fase capture-only se respeta.
- `npm run audit:health` a las 15:58:14 UTC: estado `delayed`, edad de fast y full
  30,3 minutos sobre un límite de 15, `blocked: 0`, `criticalFailed: []`,
  `notice: disabled`. El retraso es el reloj parado, no un fallo de SQL.

### La doble llave del modo: por qué cambiar una variable no basta

Auditoría de solo lectura de la cadena que decide el modo efectivo. El orden de
precedencia, de arriba abajo:

1. Flags de línea de órdenes `--capture-only` / `--process-only` (`src/main.ts:50`).
   No se usan: `npm start` no pasa flags.
2. **El input `mode` del dispatch, si no es `auto`** (`.github/workflows/monitor.yml:90`).
3. La variable de repositorio `vars.MONITOR_MODE`.
4. El fallback del workflow y el del código, ambos `full`
   (`monitor.yml:90`, `src/pipeline/profile.ts:8`).

De ahí sale el aviso más importante para la activación:

> **Cambiar `vars.MONITOR_MODE` a `full` NO basta.** El Worker envía siempre
> `mode: env.MONITOR_MODE` (`cloudflare-dispatcher/src/worker.ts:51`), hoy
> `capture-only`, y ese input **gana** sobre la variable del repositorio. Los
> ciclos externos seguirían capturando sin procesar.
>
> Y al revés: si solo se cambia el Worker, los ciclos del **cron de respaldo**
> de GitHub (:07 y :37, evento `schedule`, que no lleva inputs) seguirían en
> captura, y el «Resumen de mañana» seguiría bloqueado porque `brief.yml:52` lee
> la variable de repositorio directamente.
>
> Hay que cambiar **las dos a la vez**.

El corte de `capture-only` no es una bandera de transporte: `src/main.ts:127-132`
retorna **antes** de construir el cliente de Anthropic, antes de puntuar y antes de
cualquier entrega. Por eso `news_usage` está vacía y no hay envíos: está
garantizado por corte de flujo.

**Two-level ya está activo.** La bandera es `NEWS_DELIVERY_MODE`
(`src/config.ts:124,153-156`), admite `legacy` o `two-level`, **no está definida**
en las variables del repositorio ni en `.env`, y su valor por defecto es
`two-level`. No hay que tocar nada para usarlo. Umbrales en
`src/pipeline/news-policy.ts:19-22`: breve desde 5, importante desde 7, excepción
de watchlist material directa desde 6, digest desde 4 y panel desde 3.

**Presupuestos vigentes**, que se conservan tal cual en la primera activación:
importantes 3/hora y 12/día; breves 6/hora, 24/día y **un intervalo mínimo de 60
minutos**; llamadas a modelos 120/día (`src/config.ts:127-134`). Umbral general 7,
`GROUP_THRESHOLD` 0,6, `MAX_ITEM_AGE_HOURS` 72, `MAX_SCORING_PER_CYCLE` 12 y
`MAX_DEEP_PER_CYCLE` 3.

**Riesgos señalados, no resueltos:**

- `wrangler.json:11` conserva `ENABLED=false`. Cualquier `wrangler deploy` sin
  `--var ENABLED:true` **apaga el reloj** como efecto colateral de cambiar
  `MONITOR_MODE`. Es la trampa exacta que advertía el traspaso.
- Con `STRATEGY=fast-only`, el perfil recorta el ciclo a **4 puntuaciones y 1
  análisis** (`src/main.ts:55-56`) sobre 6 feeds. Con 31 pendientes, drenar el
  backlog sería lento, y `MAX_PENDING_HOURS=48` puede caducar filas antes de
  llegar a ellas.
- El cron de respaldo de GitHub sigue activo, así que activar el procesamiento
  produciría ciclos reales aunque el reloj siga muerto — pero sin cadencia: el
  último `schedule` entregado fue el de las **14:19:42 UTC**.

### El fallo que sí explicaba la falta de noticias, corregido

Encontrado al verificar si los breves pueden salir sin llenar un lote. **Un breve
irredactable bloqueaba todo el canal de breves, cada ciclo, hasta que todas las
noticias caducaban a las 48 horas sin enviarse nunca.**

Cómo ocurría: si el modelo devuelve un `one_liner` con una cifra que no aparece en
el título ni en el resumen del original, `formatInteresting` lanza
`short_fact_not_supported` (`src/notify/news-formats.ts:29`). Eso está **bien**: es
el guardarraíl antifabricación haciendo su trabajo. Lo que estaba mal es dónde
caía la excepción: `formatNewsBatch` redacta el lote entero de una vez
(`news-formats.ts:51`) dentro de un solo `try` que envolvía el bucle completo
(`news-delivery.ts:95`), así que una sola noticia venenosa sacaba el `throw` del
lote entero. Y como la cola ordena por crítico y luego por antigüedad
(`queue.ts:372`), esa misma noticia volvía a encabezar el lote en el ciclo
siguiente, y en el siguiente. Resultado observable: `sent: 0, failed: 1` en cada
ciclo, ninguna noticia entregada y ninguna cerrada, hasta que las sanas caducaban
con `expired_interest` sin haberse enviado.

La ruta de importantes ya aislaba el fallo por noticia —cada elemento tiene su
propio `try` (`news-delivery.ts:85`) y degrada a breve respaldado cuando el
análisis profundo falla—. La de breves no lo hacía.

**Corrección** (`src/pipeline/news-delivery.ts`): antes de redactar el lote, cada
breve se valida por separado; el que no se puede redactar se aparta solo, con
motivo `deferred_unsupported_fact`, y los sanos salen. Se aplica el mismo criterio
a un lote demasiado largo: se reduce, y si ni una sola noticia cabe, se aparta
ella y no el canal. No se marca `sent` nada que no se haya enviado, no se borra
ninguna fila y la noticia apartada sigue en la cola.

**Prueba de regresión** en `test/news-levels.test.ts`, «un breve irredactable se
aparta solo y no bloquea el canal»: tres breves, uno con una cifra sin respaldo.
Comprobado que **falla contra el código anterior y pasa con el arreglo**, que el
cuerpo enviado contiene las dos sanas y no la venenosa, y que la venenosa es la
única que queda pendiente.

Suite completa tras el cambio: **664 tests** y `typecheck` en verde.

### Lo demás que se verificó de la entrega

- **Los breves salen sin llenar lote.** No existe ningún tamaño mínimo: el lote se
  recorta hacia abajo, nunca se espera a completarlo (`news-delivery.ts:89`). Lo
  único que retiene un breve solitario es el **intervalo de 60 minutos**, y lo
  **aplaza** con su `nextAt`, no lo pierde.
- **Las cuotas aplazan, no descartan**, en las tres capas: el cupo por ciclo corta
  el plan y deja el resto `pending`; el presupuesto de modelos marca
  `retryable_failed` con `budget_exhausted` y reintento; y las cuotas de entrega
  llaman a `defer()` sin cerrar la entrega, así que la noticia reaparece.
- Queda señalado, sin tocar: un aplazamiento por presupuesto consume un intento y
  alarga el backoff exponencial hasta reintentos cada 6 horas, con caducidad a las
  48. Una noticia que coincida varios ciclos con el presupuesto agotado puede
  caducar sin que nunca se llamara al modelo por ella.

### Backlog: qué son realmente los 31 pendientes

Revalidado a las 17:00 UTC, sin cambios respecto al traspaso. Inventario completo
con antigüedad y entrega previa en `.cache/claude-pendientes.txt`.

**El dato que cambia la lectura: no son 31 noticias que fueron llegando.** Las 31
filas tienen `first_captured_at` entre las **15:26 y las 15:27 UTC**, la primera
vuelta tras crear la cola. Son la foto inicial de lo que las fuentes mostraban en
ese momento, no un flujo acumulado. Activar el procesamiento sin política las
trataría como si acabaran de publicarse.

Composición real:

| Grupo | Filas | Situación |
| --- | --- | --- |
| Con entrega propia `sent` | 5 | Protegidas por el libro de entregas |
| Incidente BCE sin entrega propia | 3 | Comunicado 12:15 UTC + 2 reescrituras de prensa |
| Indicadores macro sin entrega | 4 | Periodo del dato de semanas o meses atrás |
| Prensa rutinaria | 19 | Cierres de bolsa, hipotecas, oro, bitcoin del día |

**Lo que ya está protegido, verificado en código y no por confianza:**

- **Un id con entrega previa no se reenvía.** `src/pipeline/news-delivery.ts:52`
  y `src/main.ts:320` consultan `alert_deliveries` y saltan la entrega ante
  cualquier estado —`sent`, `rejected`, `uncertain`, `sending`— salvo con
  `--force`, que no se va a usar. Cubre las 5 filas del primer grupo.
- **Las cuotas aplazan, no descartan.** `news-delivery.ts:64` llama a `defer()`
  con el motivo y el `nextAt` que devuelve `reserve_news_budget` cuando el
  presupuesto no permite la reserva.
- **La antigüedad filtra prensa vieja** con `MAX_ITEM_AGE_HOURS=72`. La pieza más
  antigua de prensa está en 65,7 h, al borde.

**Lo que NO está protegido y necesita decisión:**

- El comunicado `rss:ecb-press:148e1a88b2fd` (12:15 UTC) y las dos reescrituras de
  `rss:investing-economy` (14:54:38 y 14:55:11 UTC) no tienen entrega propia. Si
  el comunicado puntúa como importante, existe una ruta que lo etiquetaría como
  **actualización** de la historia ya entregada en vez de duplicado
  (`news-delivery.ts:36`, motivo `material_update_of_delivered_story`), pero solo
  si la fila de Lagarde ya está `scored` en ese instante, y eso depende del orden
  dentro del ciclo. No es una garantía.
- Los 4 indicadores macro sin entrega no son publicaciones nuevas: son el valor
  vigente de la serie, capturado por primera vez al crear la cola.
- Las 19 piezas rutinarias son el riesgo de inundación real con el umbral de
  breve en 5, no el BCE.

**Motivo veraz disponible.** La restricción `capture_queue_reason_check`
(`neon/migrations/20260910_news_control.sql`) admite `duplicate_story`, que es
exactamente lo que son el comunicado y sus dos copias de prensa respecto de la
declaración ya entregada, y `legacy_processed` para lo que procesó y entregó el
sistema anterior. No hace falta inventar un motivo ni reutilizar uno falso.

**Aviso sobre `news_decisions`:** filtra el resumen matinal (`src/db/brief.ts:22`)
y las lecturas del panel (`src/db/lectura.ts:126`, `:186`), pero **no** veta la
entrega a Telegram: esa ruta escribe la decisión con `putDecision`, no la lee como
bloqueo. Escribir ahí una decisión de nivel `none` no impediría un envío.

### Backlog del BCE, delimitado

Ocho pendientes marcados como críticos. La relación que el traspaso pedía
resolver, ya con ids delante:

| id | publicado | entrega propia |
| --- | --- | --- |
| `rss:ecb-press:148e1a88b2fd` «Monetary policy decisions» | 12:15 UTC | **ninguna** |
| `rss:ecb-press:eb43a70a1a0f` «Christine Lagarde, Boris Vujčić: Monetary policy statement» | 13:00 UTC | `sent` 14:20:37 UTC |

Son ids distintos y hechos equivalentes: el comunicado de la decisión y la
declaración que la explica. Alberto **ya recibió** aviso del segundo. Los otros
seis pendientes críticos son dos reescrituras de prensa del mismo alza de tipos
(`rss:investing-economy`, 14:54:38 y 14:55:11 UTC, sin entrega) y cuatro
indicadores macro, de los cuales tres —paro EE. UU., PIB de la zona euro e IPC de
EE. UU.— ya tienen `sent` por su propio id y solo el IPC armonizado de la zona
euro (periodo 2026-07) está sin entregar.

Consecuencia práctica, que **no** se ejecuta sin autorización: habilitar el
procesamiento tal cual pondría en cola un aviso del comunicado de las 12:15 y
posiblemente sus copias de prensa, varias horas después de un aviso ya recibido
por el mismo hecho. Los ids con `sent` propio quedan protegidos por el descarte
de ids ya procesados; los que no lo tienen, no. Alberto, consultado a las 18:12
Madrid, decide **posponer la elección** al paso de habilitar procesamiento, con la
cola revisable delante. Las tres salidas sobre la mesa: dejarlo fluir; excluirlo
con motivo veraz y persistido («ya avisado bajo `eb43a70a1a0f` a las 14:20:37
UTC»); o fijar un corte de antigüedad declarado. No se ha marcado `sent` sin acuse, ni liberado
reclamos, ni tocado fechas.

Aviso de medición: `first_captured_at` de todas estas filas es 15:26–15:27 UTC,
la hora de la primera captura tras crear la cola, no la de su publicación real.
Los cuatro incumplimientos de captura y los cuatro de alerta que reporta
`audit:health` salen de ese arranque y **no** miden el objetivo publicación→captura.

## Siguiente secuencia

Primero arreglar el reloj: hace falta acceso a Cloudflare para ver si el cron se
ejecuta y qué responde el dispatch. Hasta que exista un `trigger=external` en
`monitor_runs`, la observación de la cadencia no ha empezado.

Después, observar varios disparos externos de fast capture-only y sus filas
persistidas. Procesamiento, Telegram, mixed y medición de publicaciones reales
siguen después de esa observación, y el backlog del BCE necesita una decisión
explícita antes del primer envío. No se marca como completada una fase solo por
haberla intentado.

La lista de tareas vive en la ficha del proyecto en Second Brain. El procedimiento
de activación y reversión completo permanece en el documento de arquitectura.

## Diagnóstico del Agente 1, 10-09 23:05 Madrid (21:05 UTC)

Continuación de la comprobación de las 16:05 UTC. **Todo lo de abajo es lectura.**
No se ha desplegado, disparado, migrado ni enviado nada. Las correcciones de
código quedan **propuestas**, no aplicadas.

### La pregunta central, respondida

**¿Ha disparado Cloudflare a GitHub de forma automática desde las 15:31 UTC del
10-09? No. Ni una sola vez en cinco horas y media.** Pero la causa **ha cambiado
a mitad de camino**, y lo que hay ahora son dos fallos distintos, uno detrás del
otro. El segundo estaba escondido debajo del primero.

| Ventana | Qué ocurre | Cómo se sabe |
| --- | --- | --- |
| 15:33 – 16:53 UTC | El planificador **no invocaba** al Worker | Nueve slots seguidos, escucha continua (234 ping/pong), cero eventos; panel de Cloudflare: «no events found» |
| 20:53 y 21:03 UTC | El planificador **sí invoca**, y el Worker **falla antes de tocar la red** | Dos slots consecutivos con evento de cron registrado, `outcome: "exception"`, `wallTime: 1 ms`, `cpuTime: 0`, mismo registro exacto |

Ninguna ejecución de GitHub creada por el reloj, en ninguna de las dos ventanas.

**Ni una ejecución manual ni el respaldo `schedule` de GitHub prueban que el cron
externo funcione.** No se ha demostrado ningún disparo automático desde
Cloudflare. Se ha demostrado lo contrario, y ahora además con el motivo exacto.

### La causa raíz de la segunda ventana: `redirect: "error"` no existe en el runtime de Cloudflare

Escucha propia de `wrangler tail news-monitor-clock --format json`, slot `:53`
del 10-09 (`scheduledTime` 20:53:55 UTC). Registro íntegro del Worker, sin
recortar nada relevante y sin ningún valor de secreto:

```json
{ "wallTime": 1, "cpuTime": 0, "outcome": "exception",
  "scriptName": "news-monitor-clock",
  "scriptVersion": { "id": "0a109b3f-d942-4412-9dd5-e3b4483e4213" },
  "event": { "cron": "3,13,23,33,43,53 * * * *", "scheduledTime": 1789073635000 },
  "logs": [ { "message": ["{\"state\":\"uncertain\",\"profile\":\"fast\"}"] } ],
  "exceptions": [ { "name": "Error", "message": "dispatch_uncertain",
    "stack": "at fail (worker.js:17:11) at dispatch (worker.js:58:12) at async Object.scheduled (worker.js:72:5)" } ] }
```

Lo que ese registro demuestra, paso a paso:

- El cron **se ejecuta**: hay `event.cron` con la expresión correcta.
- `ENABLED` vale `true`, `selectProfile` acierta y devuelve `fast`: el registro
  lleva `profile: "fast"`, que solo se escribe después de esa selección.
- Toda la validación de configuración pasa —propietario, repositorio, workflow,
  referencia, presencia del secreto y modo—, porque si no el estado sería
  `invalid_config`.
- Y entonces el `fetch` **revienta en 1 milisegundo, con 0 ms de CPU**. Eso no es
  una red lenta ni un timeout: es una excepción **síncrona**, lanzada al construir
  la petición, antes de que salga un solo byte hacia `api.github.com`.

El motivo está escrito, literalmente, dentro del binario `workerd` que trae
wrangler 4.130.0 (`node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe`):

```
TypeError: Invalid redirect value, must be one of "follow" or "manual"
("error" won't be implemented since it does not make sense at the edge;
 use "manual" and check the response status code).
```

Y `cloudflare-dispatcher/src/worker.ts:48` pide exactamente eso:

```ts
method: "POST", redirect: "error", signal: controller.signal,
```

El slot siguiente, `:03` (`scheduledTime` 21:03:55 UTC), produjo **exactamente el
mismo registro**: `outcome: "exception"`, `wallTime: 1 ms`,
`{"state":"uncertain","profile":"fast"}`, `dispatch_uncertain`. Dos de dos. No es
intermitente.

**Cada invocación del reloj falla igual, siempre, por construcción.** GitHub no
rechaza nada porque GitHub nunca se entera: no hay 401, 403, 404 ni 422 que
buscar. No es propagación, no es el token, no es el alcance, no es la referencia.

**Por qué 664 pruebas en verde no lo vieron.** Dos motivos que se refuerzan:

1. `test/clock-worker.test.ts:14` inyecta un `fetch` simulado por
   `dependencies.fetch`. El objeto de inicialización nunca llega a `workerd`, así
   que nadie valida `redirect`. Peor: la línea 20 **afirma** `redirect: "error"`,
   de modo que la suite fija el valor que el runtime real rechaza.
2. `cloudflare-dispatcher/` **no tiene `tsconfig.json` ni
   `@cloudflare/workers-types`**. El worker se comprueba con las definiciones del
   proyecto principal, donde `RequestRedirect` incluye `'error'`
   (`node_modules/undici/types/fetch.d.ts:173`). TypeScript da por bueno un valor
   que el runtime de destino no acepta.
3. `npm run validate` es `wrangler deploy --dry-run`: empaqueta, no ejecuta.

Es el fallo clásico de un módulo probado contra un runtime distinto del suyo.

### Estado efectivo de los cinco disparadores, 21:05 UTC

| Disparador | Estado real | Modo efectivo |
| --- | --- | --- |
| **Worker `news-monitor-clock`** | Cron registrado y **ahora sí invocado**; **cero dispatch entregados** por el fallo de `redirect` | `ENABLED=true`, `STRATEGY=fast-only`, `MONITOR_MODE=capture-only`; versión activa `0a109b3f` |
| **Worker `news-monitor-clock-2`** | Desplegado 16:57:17 UTC, versión `eceb0051`, **sin `GITHUB_TOKEN`**, inerte a propósito | Su prueba ya no aporta nada: el original sí se ejecuta. Candidato a retirar |
| **Monitor (`monitor.yml`)** | `active`. Solo lo dispara el respaldo `schedule` de GitHub, tarde y a saltos | `capture-only` por `vars.MONITOR_MODE`; `schedule` fuerza perfil `full` |
| **Agenda (`agenda.yml`)** | `disabled_manually` | No se ejecuta en absoluto |
| **Resumen (`brief.yml`)** | `disabled_manually` | No se ejecuta; su puerta además leería `capture-only` |
| **Latido (`keepalive.yml`)** | `active`, sin cambios | Próximo disparo el día 15 |

### Lo que sí corre, y por qué no basta

Desde la activación del reloj solo se han creado **dos** ejecuciones, ambas del
respaldo `schedule` de GitHub, y con el hueco de siempre:

```
gh run list --workflow monitor.yml --json databaseId,event,status,conclusion,createdAt,displayTitle
34518310109  schedule          success  2026-09-10T19:05:30Z  Monitor (capture-only) [full]
34515683949  schedule          success  2026-09-10T18:39:34Z  Monitor (capture-only) [full]
34495721148  workflow_dispatch success  2026-09-10T15:27:09Z  Monitor (capture-only) [full]   <- manual, previa al reloj
34495563870  workflow_dispatch success  2026-09-10T15:25:42Z  Monitor (capture-only) [fast]   <- manual, previa al reloj
34488318355  schedule          success  2026-09-10T14:19:42Z  Monitor
```

**Cuatro horas y veinte minutos sin ninguna ejecución** entre las 14:19:42 y las
18:39:34 UTC. Es el mismo comportamiento que motivó todo este trabajo.

En Neon, `monitor_runs` tiene **cuatro filas** y ninguna `external`:

| trigger | perfil | modo | n | última |
| --- | --- | --- | ---: | --- |
| `schedule` | full | capture-only | 2 | 19:05:52 UTC |
| `manual` | full | capture-only | 1 | 15:27:33 UTC |
| `manual` | fast | capture-only | 1 | 15:26:00 UTC |
| `external` | — | — | **0** | — |

La fase de observación se está respetando de forma verificable: `news_usage`
**vacía** (cero llamadas a modelos), `alert_deliveries` con las mismas **14 filas
`sent`** y el mismo último acuse de las **14:20:37 UTC**, y `events` sin filas
nuevas desde las 14:21:02 UTC. La cola sí crece: **38 `pending`** (5 críticos) y
205 `discarded`, con la más antigua en 15:26:00 UTC.

`npm run audit:health` a las 20:49:45 UTC: `["no_recent_execution", "aged_queue"]`,
edad de fast y full **103,5 minutos** sobre límites de 15 y 45, `blocked: 0`,
`criticalFailed: []`. Los dos incumplimientos que reporta salen del arranque de la
cola, no del objetivo publicación→captura.

### Cómo se distingue un disparo del reloj de uno de Alberto

Los dos llegan a GitHub como `event = workflow_dispatch` y con el mismo actor
—`seeorr`, el dueño del token—, así que el evento y el actor **no** distinguen
nada. Lo que sí distingue, por orden de fiabilidad:

1. **La fila de `monitor_runs`.** El Worker manda `origin: "external"`, y
   `monitor.yml:92` lo convierte en `MONITOR_ORIGIN`, que `profile.ts:9` guarda
   como `trigger`. Un manual por la interfaz trae `origin` con su valor por
   defecto `manual`. **Es la única señal que llega hasta la base de datos.**
   Advertencia honesta: `origin` es una etiqueta operativa, no autenticación —
   cualquiera puede elegir `external` en el desplegable.
2. **El `displayTitle` combinado con el minuto.** El Worker con `fast-only` pide
   siempre `fast`, así que un disparo suyo se lee `Monitor (capture-only) [fast]`
   y cae en `:03`, `:13`, `:23`, `:33`, `:43` o `:53` UTC, con pocos segundos de
   margen. Un manual raramente cae justo en esos minutos, y por defecto pide
   `full`. Un `schedule` de GitHub no lleva inputs y siempre sale `[full]`.
3. **La regularidad.** Seis por hora, siempre los mismos minutos. Una sola
   ejecución en un minuto correcto es coincidencia posible; seis seguidas no.

Las dos ejecuciones `workflow_dispatch` de hoy —15:25:42 y 15:27:09 UTC— fallan
las tres pruebas: minutos que no son del cron, `trigger=manual` en Neon y una
`[fast]` seguida de una `[full]` a minuto y medio. Son manuales, y además
**anteriores** a la activación del reloj a las 15:32:04.

### Precedencia de configuración: el orden real, de arriba abajo

Confirmado leyendo el código, no la documentación. Gana el primero que exista:

| # | Fuente | Dónde | Alcance |
| --- | --- | --- | --- |
| 1 | Banderas de CLI `--capture-only` / `--process-only` | `src/main.ts:50-51` | Solo ejecución local: `npm start` no pasa banderas |
| 2 | Input `mode` del `workflow_dispatch`, **si no es `auto`** | `monitor.yml:90` | Solo `workflow_dispatch`. **El Worker manda siempre `mode: env.MONITOR_MODE`** (`worker.ts:53`) |
| 3 | Variable de repositorio `vars.MONITOR_MODE` | `monitor.yml:90`, `brief.yml:52` | `schedule`, manuales con `auto`, y la puerta del Resumen |
| 4 | Valor por defecto `full` | `monitor.yml:90`, `profile.ts:8` | Cuando no hay nada más |

Para el perfil manda otra cadena distinta, y conviene no confundirlas:
`github.event_name == 'schedule'` **fuerza `full`** (`monitor.yml:91`) por encima
de cualquier input; solo si no es `schedule` se mira `inputs.profile`; el
defecto es `full`. Es decir: **el respaldo `:07`/`:37` siempre corre `full`,
aunque el Worker esté en `fast-only`.** No es un error, pero cuesta el doble.

Las variables del Worker (`ENABLED`, `STRATEGY`, `MONITOR_MODE`) no compiten con
las del repositorio: viven en otro sitio y solo deciden **qué pide** el Worker.
La contradicción aparece en el escalón 2 contra el 3.

**Dónde una configuración puede contradecir a la otra, hoy mismo:**

- **La doble llave del modo.** Cambiar `vars.MONITOR_MODE` a `full` no basta: el
  input del Worker gana y los ciclos externos seguirían capturando sin procesar.
  Cambiar solo el Worker tampoco: el respaldo `schedule` y la puerta de
  `brief.yml:52` leen la variable del repositorio. **Hay que cambiar las dos.**
- **La trampa de `wrangler.json:11`.** El archivo versionado conserva
  `ENABLED: "false"` mientras producción tiene `true`. Cualquier
  `npx wrangler deploy` sin `--var ENABLED:true` **apaga el reloj** como efecto
  colateral de cualquier otro cambio. Y ahora hace falta desplegar para arreglar
  `redirect`, así que la trampa está armada justo delante del siguiente paso.
- **`STRATEGY` contra el respaldo.** `fast-only` en el Worker no impide que
  `:07`/`:37` corran `full`. La estrategia no es global.

### Agenda y Resumen durante `capture-only`

- **Agenda** no tiene ninguna protección de modo: sus tres crons y su
  `workflow_dispatch` envían Telegram sin mirar `MONITOR_MODE`. **Lo único que la
  contiene hoy es que está `disabled_manually`.** Al restaurarla vuelve a enviar.
  Su idempotencia es por día (`seen.has(event.id)`), no por modo.
- **Resumen** sí tiene puerta, y es buena: se evalúa **antes** del checkout, de
  `npm ci` y de leer secretos (`brief.yml:38-60`). Bloquea si
  `vars.MONITOR_MODE == 'capture-only'`, si el `workflow_run` que lo despertó
  lleva título `Monitor (capture-only)`, si es `[fast]` o `[process]`, si el
  origen no es de confianza o si el run anterior no acabó en `success`. Además de
  eso está `disabled_manually`.
- Consecuencia práctica para el orden de activación: **poner
  `vars.MONITOR_MODE=full` reabre la puerta del Resumen**, pero mientras siga
  `disabled_manually` no se ejecuta. La protección real durante la primera
  ventana de procesamiento es el estado `disabled_manually`, no la variable.

### El hueco del aviso: quién se entera de un rechazo

Lo que **sí** está bien y no hay que tocar:

- El Worker clasifica correctamente las respuestas de GitHub: 401, 403, 404, 422
  y 429 → `rejected` con su `http`; cualquier otro estado → `uncertain`; corte por
  `AbortSignal` → `timeout`. No lee cuerpos, no imprime el token, no reintenta.
- `sendTelegram` (`src/notify/telegram.ts:207-210`) **sí** detecta `ok:false`:
  exige `res.ok && body.ok === true && Number.isInteger(body.result.message_id)`
  para declarar `sent`, y solo llama `rejected` a un 4xx coherente con
  `error_code === status`. Todo lo demás queda `uncertain` y **bloqueado**.

El hueco es otro, y son tres capas:

1. **`uncertain` mezcla dos cosas incompatibles.** El fallo de hoy es
   determinista y permanente —un valor que el runtime no acepta— y se registra
   con el mismo estado que un corte de red pasajero. `catch { return fail(...) }`
   descarta el error entero (`worker.ts:55`), así que ni el nombre de la
   excepción sobrevive. Un estado que dice «incierto» invita a esperar; este
   fallo había que arreglarlo. **Cinco horas perdidas salen justo de ahí.**
2. **Nadie fuera de Cloudflare se entera.** No hay ningún camino del Worker a
   Neon, a Telegram ni a GitHub. Un dispatch rechazado o incierto vive solo en
   Cron Events. Si nadie mira el panel, el sistema calla.
3. **`sendOperationalNotice` no está cableado en ninguna parte automática.**
   Existe, funciona y está probado, pero su único invocador es
   `scripts/auditar-salud.ts:49`, tras `--notify` **y** `HEALTH_NOTICES_ENABLED=true`.
   `grep` sobre `.github/workflows/` no encuentra ni una referencia a
   `audit:health`. **`src/main.ts` no lo llama nunca.** No existe observador
   independiente. Confirmado: la parada del reloj la descubrió una persona
   mirando, no el sistema.
   Y aunque estuviera cableado, `evaluateHealth` no tiene hoy un estado que
   signifique «solo hay ejecuciones manuales»: una captura manual reciente
   devuelve `healthy`. Ese estado (`trigger_inactive`) es trabajo del Agente 3.

Además, `monitor.yml:169` apaga el aviso de fallo por Telegram cuando
`MONITOR_MODE == 'capture-only'`. Es coherente con la fase, pero significa que
**durante toda la observación no hay ningún aviso de ningún tipo**. Es una
decisión, no un error; conviene decirla en voz alta.

### Diffs propuestos para la oleada 2 — NO aplicados

**D1 · `cloudflare-dispatcher/src/worker.ts` — arreglar el disparo y dejar de
llamar «incierto» a un fallo permanente.**

```diff
-      (dependencies.fetch ?? fetch)(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
-        method: "POST", redirect: "error", signal: controller.signal,
+      // workerd no implementa redirect:"error" y lanza TypeError al construir la
+      // petición: con "manual" la redirección NO se sigue y llega como 3xx, que
+      // esta función clasifica abajo. Misma garantía, runtime real.
+      (dependencies.fetch ?? fetch)(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
+        method: "POST", redirect: "manual", signal: controller.signal,
```

y, para que un fallo determinista no vuelva a disfrazarse de red inestable:

```diff
-export type DispatchState = "disabled" | "accepted" | "rejected" | "timeout" | "uncertain" | "invalid_config";
+export type DispatchState = "disabled" | "accepted" | "rejected" | "timeout" | "uncertain" | "invalid_config" | "invalid_request";
```

```diff
-  } catch { return fail(controller.signal.aborted ? "timeout" : "uncertain"); }
+  } catch (error) {
+    if (controller.signal.aborted) return fail("timeout");
+    // Un TypeError aquí es la petición mal construida —valor no soportado por el
+    // runtime—, no un problema de red: es permanente y hay que arreglarlo, no esperar.
+    return fail(error instanceof TypeError ? "invalid_request" : "uncertain");
+  }
```

Nada de esto imprime el error, la URL ni el token: solo el nombre del estado.
Una redirección sigue sin seguirse; un 301/302 cae en la rama `uncertain` con su
`http`, que es más información que hoy, no menos.

**D2 · `test/clock-worker.test.ts` — que la suite deje de fijar el valor roto.**

```diff
-    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: { Accept: "application/vnd.github+json",
+    expect(request).toMatchObject({ method: "POST", redirect: "manual", headers: { Accept: "application/vnd.github+json",
```

Y una prueba nueva que cubra el hueco de verdad: un `fetch` inyectado que rechace
con `new TypeError(...)` debe producir `invalid_request`, no `uncertain`.

**D3 · `cloudflare-dispatcher/` — comprobar el worker contra su propio runtime.**
La prueba anterior sigue siendo simulada. Lo que impediría la reincidencia es
añadir `@cloudflare/workers-types` y un `tsconfig.json` propio en
`cloudflare-dispatcher/` con `"types": ["@cloudflare/workers-types"]`, para que
`redirect: "error"` **no compile**. Es la única de las tres que ataca la causa y
no el síntoma. Decisión de producto: añade una dependencia de desarrollo.

**D4 · `cloudflare-dispatcher/wrangler.json` — desarmar la trampa de `ENABLED`.**
Hoy el archivo dice `false` y producción dice `true`; un `deploy` distraído apaga
el reloj. Dos salidas, y hay que elegir una antes de desplegar el arreglo:

- **(a)** Poner `"ENABLED": "true"` en `wrangler.json`. Un `deploy` normal pasa a
  ser idempotente con producción. Coste: cualquiera que despliegue desde su
  portátil enciende un reloj.
- **(b)** Conservar `false` arriba y añadir un entorno explícito
  `"env": { "produccion": { "name": "news-monitor-clock", "vars": { ...las siete, con ENABLED true... } } }`,
  desplegando siempre con `--env produccion`. Ojo: los `vars` de un entorno
  **no heredan** los de arriba en wrangler; hay que repetir las siete.

Recomendación: **(b)**, porque hace explícito el acto de encender y no depende de
recordar un `--var`. Necesita la decisión de Alberto.

**D5 · Detección de la parada.** Fuera del alcance de esta oleada porque toca
`src/main.ts` (prohibido) y el vocabulario de salud (Agente 3). Lo que sí cabe en
`.github/workflows/` es un workflow `salud.yml` de solo lectura que ejecute
`npm run audit:health` **sin `--notify`**: su código de salida 1 pinta el run en
rojo y eso ya es una señal visible. Advertencia que no hay que esconder: lo
dispararía el mismo planificador de GitHub que descarta crons, así que es un
detector débil. La detección honesta es un observador independiente del reloj que
falla. Queda como decisión pendiente, no como diff.

## Procedimiento para pasar de `capture-only` a funcionamiento completo

Escrito para ejecutarse **después** de la oleada 2 y con autorización expresa de
Alberto para efectos reales. **Aquí no se ejecuta ninguno de estos pasos.**
Cada paso lleva su comprobación y su reversión; ninguno se da por bueno sin ella.

### Paso 0 · Bloqueos previos, antes de tocar nada

1. **El backlog del BCE tiene que estar decidido.** Sigue abierto: el comunicado
   `rss:ecb-press:148e1a88b2fd` (12:15 UTC) y las dos reescrituras de prensa no
   tienen entrega propia, y habilitar el procesamiento las pondría en cola.
   Alberto pospuso la elección a este punto. **Sin decisión escrita, no se sigue.**
2. **El arreglo del reloj tiene que estar aplicado y probado en local**
   (`npm test`, `npm run typecheck`, `npm run validate` en `cloudflare-dispatcher/`).
3. Anotar el estado de partida para poder volver:
   `gh workflow list --all`, `gh variable list`,
   `npx wrangler versions view <id activo>`, y la lectura de
   `npm run audit:health`. Guardarlo con fecha.

### Paso 1 · Arreglar el reloj, todavía en `capture-only`

Desplegar el Worker corregido **sin cambiar ningún modo**:

```powershell
cd cloudflare-dispatcher
npx wrangler deploy            # con D4(b) aplicado: --env produccion
```

**Comprobar, y no seguir sin esto:**

- `npx wrangler versions view <nueva versión>` sigue diciendo `ENABLED="true"`,
  `STRATEGY="fast-only"`, `MONITOR_MODE="capture-only"` y secreto `GITHUB_TOKEN`
  presente. Si `ENABLED` salió `false`, la trampa de `wrangler.json` se disparó:
  volver a desplegar con el valor correcto antes de nada más.
- `npx wrangler tail news-monitor-clock --format json` durante un slot completo:
  el registro tiene que decir `{"state":"accepted","profile":"fast","http":200}`
  o `204`. Si dice `rejected` con `http`, es el token o el alcance —corregir eso,
  no volver a desplegar a ciegas—. Si dice `invalid_request`, el arreglo no está
  completo.
- **La prueba que de verdad cierra el paso**, y la única que vale:

```powershell
gh run list --workflow monitor.yml --limit 10 --json databaseId,event,createdAt,displayTitle
```

  tiene que enseñar ejecuciones `workflow_dispatch` con título
  `Monitor (capture-only) [fast]` en los minutos `:03/:13/:23/:33/:43/:53`, y en
  Neon tiene que aparecer al fin `trigger = external`:

```sql
select record->>'trigger', count(*) from monitor_runs
where started_at > now() - interval '2 hours' group by 1;
```

- **Observar al menos una hora**, es decir seis slots. Un solo dispatch aceptado
  no es cadencia. Comprobar de paso que recapturar sube apariciones y no únicas,
  que `news_usage` sigue vacía y que `alert_deliveries` no crece.

**Reversión del paso 1:** `ENABLED=false` en el Worker, o revocar el token en
GitHub si hace falta parar ya. El respaldo `:07`/`:37` sigue vivo. Nada que
deshacer en la base: capturar es aditivo.

### Paso 2 · Un solo ciclo completo, controlado y observado

Antes de cambiar ninguna configuración permanente, un único disparo manual con
el modo explícito. Es el primer efecto real —modelos y Telegram— y necesita el
«adelante» de Alberto en ese momento, con la cola delante:

```powershell
gh workflow run monitor.yml -f profile=full -f mode=full -f origin=manual
```

**Comprobar:** el run acaba `success`; `news_usage` tiene filas por primera vez y
dentro del presupuesto; `alert_deliveries` crece solo con estados `sent`
—ninguna fila `uncertain` o `sending` colgada—; los mensajes recibidos son los
que se esperaban y **no** un reenvío del incidente del BCE. Si aparece una fila
`uncertain`, **parar aquí**: no se libera por tiempo, hay que reconciliarla.

**Reversión del paso 2:** ninguna posible sobre lo ya enviado. Por eso el paso 0.1
es bloqueante. Lo que sí se hace es no continuar.

### Paso 3 · La doble llave del modo, las dos a la vez

Primero la variable del repositorio, que es instantánea y se revierte con una
orden, y afecta como mucho a dos ejecuciones por hora:

```powershell
gh variable set MONITOR_MODE --body full
```

Inmediatamente después, el Worker (`MONITOR_MODE: "full"` en `wrangler.json`,
o `--var MONITOR_MODE:full --var ENABLED:true`):

```powershell
cd cloudflare-dispatcher; npx wrangler deploy
```

**Comprobación de coherencia — el paso que impide que una configuración
contradiga a la otra.** Las tres fuentes tienen que decir lo mismo:

1. `gh variable list` → `MONITOR_MODE  full`
2. `npx wrangler versions view <activa>` → `env.MONITOR_MODE ("full")` **y**
   `env.ENABLED ("true")`
3. `gh run list --workflow monitor.yml --limit 10 --json displayTitle,event,createdAt`
   → **todas** las ejecuciones nuevas, de los dos orígenes, tienen que leerse
   `Monitor (full) [...]`. Si queda una sola `Monitor (capture-only)`, hay una
   llave sin girar: si es `event=schedule`, falta la variable del repositorio; si
   es `event=workflow_dispatch` en minuto del cron, falta el Worker.
4. En Neon, la comprobación definitiva, porque mira el modo que el programa
   realmente aplicó y no el que el título anuncia:

```sql
select record->>'trigger' as origen, record->>'mode' as modo, count(*)
from monitor_runs where started_at > now() - interval '1 hour' group by 1,2;
```

   No debe quedar ninguna combinación con `modo = 'capture-only'`.

**Reversión del paso 3:** `gh variable set MONITOR_MODE --body capture-only` y
desplegar el Worker con `MONITOR_MODE:capture-only`. Las dos, otra vez, o queda
medio sistema procesando. Volver a correr la comprobación de coherencia con el
valor contrario. Nada de lo ya enviado se deshace.

### Paso 4 · Restaurar Agenda y Resumen a su estado previo

Estado anterior registrado en `.cache/activation-remote-settings-before.json`
(10-09 15:22:25 UTC): `agenda.yml` **`active`**, `brief.yml` **`active`**,
`monitor.yml` **`active`**, y **ninguna variable de repositorio definida**.

Se restaura **después** del paso 3 y no antes, porque reactivar `brief.yml`
reabre su disparador `workflow_run` sobre cada Monitor y su puerta ya no bloquea
en cuanto la variable dice `full`:

```powershell
gh workflow enable agenda.yml
gh workflow enable brief.yml
gh workflow list --all      # los cuatro tienen que decir "active"
```

**Comprobar:** el primer día laborable siguiente, en la ventana de 06:00 a 12:00
UTC, que la Agenda sale **una sola vez** —su claim por día tiene que absorber los
tres crons y la recuperación desde `brief.yml`— y que el Resumen sale una sola
vez. Un segundo intento que salga `blocked` **no es un fallo**. Vigilar también
el número de jobs cortos de `brief.yml` disparados por `workflow_run`: son hasta
192/día y hay que ver el coste real, no el estimado.

**Reversión del paso 4:** `gh workflow disable agenda.yml` y
`gh workflow disable brief.yml`. Vuelven exactamente al estado de hoy.

### Paso 5 · `mixed`, el último

Solo con los pasos 1 a 4 observados durante al menos un día completo:
`STRATEGY: "mixed"` en el Worker y desplegar. Pasa a `full` en `:03` y `:33`, y
`fast` en el resto. Comprobar el consumo de modelos contra el límite de 120/día y
la carga en Neon antes de darlo por bueno.

**Reversión del paso 5:** `STRATEGY:fast-only` y desplegar.

### Reversión completa, en orden, si algo sale mal a mitad

> **Sustituida el 14-09-2026 por [`reversion.md`](reversion.md).** Se conserva como
> historia. El paso 2 está desfasado: el Worker manda `mode: auto`, así que
> `capture-only` es una sola llave, la variable de GitHub, y no hay que desplegar
> el Worker. `news-monitor-clock-2` ya no existe.

1. `ENABLED=false` en el Worker —o revocar el token en GitHub si hay que parar
   ya— para cortar disparos nuevos. Los cambios de cron tardan en propagarse; el
   token no.
2. `gh variable set MONITOR_MODE --body capture-only` **y** desplegar el Worker
   con `capture-only`. Las dos llaves.
3. `gh workflow disable agenda.yml` y `gh workflow disable brief.yml`.
4. Comprobar con la consulta de coherencia del paso 3 que no queda ninguna
   ejecución nueva en modo `full`.
5. Retirar `news-monitor-clock-2` cuando el original esté probado; hoy es inerte
   porque no tiene token, pero un token cargado ahí por error dispararía doble.

Lo que **no** se hace nunca en una reversión: borrar pendientes de
`capture_queue`, liberar filas `sending`/`uncertain` de `alert_deliveries`, usar
`--force`, tocar fechas o restaurar una base antigua encima. Un job ya arrancado
conserva su token efímero de Actions: revocar el PAT no lo cancela, y no se
cancela a ciegas un job que puede estar enviando.

### Lo que sigue sin estar demostrado

- Que el reloj entregue dispatch aceptados. Hoy **no lo hace**, y la causa está
  identificada pero no corregida.
- La puntualidad publicación→captura (<10 min) y publicación→acuse (<15 min)
  sobre publicaciones reales futuras. Las medidas actuales salen del arranque de
  la cola y no valen para eso.
- La primera ventana de procesamiento con el backlog decidido.
- Que el sistema avise de su propia parada. Hoy no puede.
