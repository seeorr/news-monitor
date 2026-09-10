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
