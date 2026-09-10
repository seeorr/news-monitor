# Registro de activación de cadencia

Inicio: 10-09-2026. Este registro continúa la implementación local descrita en
[cadencia-cloudflare.md](cadencia-cloudflare.md). Los resultados de aquella fase
siguen en [verificacion-cadencia.md](verificacion-cadencia.md).

## Estado a las 17:23 de Madrid

- GitHub: acceso de escritura comprobado; rama predeterminada `main`, remota en
  `a1b161d` antes de publicar. Monitor, Agenda y Resumen pausados para la ventana
  de observación; Latido conserva su estado. No había jobs en curso en la última
  lectura. Estados originales guardados en `.cache/activation-remote-settings-before.json`.
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
- El despliegue terminó con **éxito parcial**: Cloudflare rechazó el cron con el
  código `10063`, porque la cuenta nueva necesita abrir por primera vez Workers
  & Pages para preparar su subdominio de cuenta. El Worker sigue apagado; no hay
  un cron confirmado ni dispatch de prueba. No se ha creado ni cargado el token
  de GitHub.

## Revisión preparada

La referencia local sigue en `037e77a`. Hay tres commits locales anteriores a
la cadencia sin publicar: `9ef925e` (protección del dashboard), `f0e0ee2` (cola,
control, cobertura y pruebas) y `037e77a` (evaluación). Publicar la rama completa
incluiría los tres. Alberto autorizó expresamente crear el commit de cadencia y
publicar el conjunto, conservando fuera los dos archivos que ya tenía modificados.

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

## Siguiente secuencia

Completar la preparación de Workers y verificar el cron con el Worker apagado;
resolver el alcance de publicación; abrir la ventana de capture-only preservando
los estados anteriores; aplicar y verificar las migraciones; publicar el código;
cargar el token restringido como secreto; activar fast capture-only y observar.
Procesamiento, Telegram, mixed y medición de publicaciones reales siguen después
de esa observación. No se marca como completada una fase solo por haberla intentado.

La lista de tareas vive en la ficha del proyecto en Second Brain. El procedimiento
de activación y reversión completo permanece en el documento de arquitectura.
