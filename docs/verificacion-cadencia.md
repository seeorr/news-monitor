# Verificación local de cadencia — 10-09-2026

Informe de la fase local, previo a la autorización de activación. El avance remoto
posterior se registra en [activacion-cadencia.md](activacion-cadencia.md).

Resultado: implementación local verificada. Despachador desactivado. No hay despliegue, token nuevo, migración remota, ejecución del monitor real, consumo de modelos ni envío de Telegram. Activación, limitaciones y reversión: [cadencia-cloudflare.md](cadencia-cloudflare.md).

## Comprobaciones ejecutadas

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` | Correcto |
| `npm test` | **663 tests, 44 archivos, todos correctos** |
| `npm run verify:queue:postgres` | **10 comprobaciones** con SQL real en PGlite local |
| `npm run verify:control:postgres` | **7 comprobaciones** con SQL real en PGlite local |
| `npm run verify:cadence:postgres` | **9 comprobaciones** con SQL real en PGlite local |
| `npm run dashboard:build` | Build Next.js 16.3.4 correcta; rutas privadas dinámicas |
| `npm run validate` en `cloudflare-dispatcher` | Wrangler **4.130.0**, `deploy --dry-run`, correcto; **3,25 KiB / 1,43 KiB gzip**; `ENABLED=false` |
| actionlint **1.7.12** | `monitor.yml` y `brief.yml` válidos; binario oficial con SHA-256 contrastado. ShellCheck no instalado: deshabilitado explícitamente |
| `node scripts/verificar-seguridad-cadencia.mjs` | 204 archivos versionables y 385 blobs del historial alcanzable; **0 coincidencias** de patrones de credenciales; ningún valor impreso |
| Escaneo final `--tree-only` | 205 archivos versionables, **0 coincidencias**; historial sin cambios, HEAD `037e77a` |
| `git diff --check` | Sin errores de espacios; avisos habituales de normalización LF/CRLF |
| Conservación de cambios previos | SHA-256 de los dos archivos del usuario idénticos al inicio |
| Límite de escritura | Cambios dentro de `codigo/`; estado del repositorio del vault limpio en la comprobación final |

El fichero generado `next-env.d.ts`, alterado automáticamente por la build para apuntar a tipos de producción, se devolvió al contenido inicial. No forma parte del cambio funcional. El typecheck se volvió a ejecutar después.

El escaneo de secretos es heurístico, no una certificación de ausencia de toda clase de dato sensible. No se inspeccionaron `.env` local, almacenes de autenticación o valores de secretos activos. La build lee su configuración habitual de Next.js; no se ejecutó ninguna ruta del monitor o transporte real.

## Matriz del encargo

| Caso obligatorio | Evidencia local |
|---|---|
| 1. Full en minutos 03/33 | `clock-worker.test.ts`, casos parametrizados UTC |
| 2. Fast en 13/23/43/53 | Mismo archivo, cuatro minutos |
| 3. Petición dispatch correcta | URL fija, método, cabeceras, JSON, sin redirección; transporte simulado |
| 4. Referencia configurada | Prueba con `release/clock`; configuración pública real `main` |
| 5. Aceptación 204 | Prueba explícita; adicional 200 por contrato API actual |
| 6. 401/403/404/422, timeout e inesperadas | Clasificación segura; también 429, 302, 500, 202 y error de red |
| 7. Token fuera de registros/errores | Marcador sensible inventado, cuerpos hostiles y excepción de red; no aparece en salidas |
| 8. Fast/full/process válidos | `cadence-profile.test.ts`, proceso Node del validador real y adaptador |
| 9. Desconocido antes de monitor/servicios | `fuga.test.ts` importa main real: no config, estado, fuentes, IA ni Telegram; workflow bloquea también aviso de fallo y resumen indirecto |
| 10. Dispatch simultáneos sin doble captura | Dos capturas concurrentes: una única; además claims/constraints de los tests de cola |
| 11. Externo y cron coincidentes sin doble entrega | Cola y ledger compartidos; cron posterior del caso BCE; entregas concurrentes simuladas; `concurrency` único en YAML |
| 12. Fast disponible para full | Cola en fichero real, reinicio, RSS vacío y pendientes conservados |
| 13. BCE delante de cola llena | **520 anteriores**, límites de lectura 12/1; probado en memoria y SQL real local |
| 14. Prensa de la misma decisión | En ambos órdenes: BCE→prensa y prensa→BCE sin entradilla; no repuntúa ni repite aviso |
| 15. Actualización material nueva | Cambio de 25 a 50 pb y de 2,50 a 2,75; segunda decisión `important` con `updateOf`; nueva liquidez no se silencia por coincidir los tipos |
| 16. Entrega incierta no se repite | Ledger `uncertain`; no segundo envío ni segundo análisis en el ciclo posterior |
| 17. Sin novedades no paga modelos | Capturas repetidas y cola procesada no vuelven a scoring; capture-only real no llama a ninguno |
| 18. Retirar Worker conserva respaldo | Dos schedule independientes :07/:37, perfil full, sin dependencia ni secreto Cloudflare en Actions |

También se mantienen los tests anteriores de excedentes **31→12→19**, reinicio con RSS sin esos excedentes, recaptura, equidad entre editores, fallo parcial de fuente y aislamiento de empresas EDGAR.

## Regresión temporal: simulación explícita

`cadence-ecb.test.ts` usa la forma del RSS oficial y párrafos mínimos contrastados, pero simula reloj, red, modelos y Telegram:

1. Backlog anterior registrado a las 11:50 UTC.
2. Publicación del comunicado a las 12:15 UTC.
3. Disparo fast correspondiente a las 12:23 UTC; primera captura **12:23:20**: demora **8 min 20 s**, anterior a 12:25.
4. Puntuación conservada; envío simulado **12:24:10**, anterior al objetivo 12:30.
5. Cron posterior a las 12:37 con recaptura y copia de prensa: sigue habiendo un solo aviso de esa decisión.
6. Una representación estructurada de `ECBDFR` con periodo 16-09 y publicación desconocida se reconoce como ese hecho, sin convertir el periodo en publicación.

Por separado, la prueba SQL calcula una demora de captura de **8 minutos** y una de acuse de **9,5 minutos** a partir de timestamps sintéticos distintos. Verifica el cálculo, no una medición del servicio en producción.

## Límites de la verificación

- PGlite ejecuta SQL real, constraints, índices, CAS, checkpoints y DDL inverso, pero es monoconexión. No reproduce la competición entre conexiones de Neon ni la latencia de Actions.
- El Worker no se ha desplegado: no se ha medido CPU, puntualidad real, logs en Cloudflare ni aceptación real de dispatch con un PAT.
- Las pruebas no demuestran cumplimiento de SLO bajo carga. La observación de varias publicaciones futuras forma parte de la activación pendiente.
- La equivalencia semántica nueva está acotada al hecho de tipos del BCE. No se afirma deduplicación universal ni detección infalible de actualizaciones con identidad reutilizada por la fuente.
- Los objetivos de alertas dependen de evidencia suficiente, cuotas, respuesta de modelos y Telegram. Los rechazos o incertidumbres requieren revisión humana; no se reenvían automáticamente.
- El aviso privado está preparado y probado con un doble de transporte, pero sigue apagado y sin programación. El CLI solo lo conecta si coinciden `--notify` y `HEALTH_NOTICES_ENABLED=true`; utiliza el ledger y un máximo de un intento diario. El informe `audit:health` sin ese flag es de lectura, no una promesa de aviso autónomo ya activo.
- El mayor número de ejecuciones puede aumentar compute/IO de Neon y las consultas auxiliares matinales. Las cifras de carga y almacenamiento son estimaciones trazables, no facturación observada.

Los siguientes pasos de Alberto están enumerados en el documento de activación: publicar revisión y migración tras revisión; desplegar Worker apagado; crear/cargar secreto restringido; observar fast capture-only; habilitar procesamiento; comprobar idempotencia; pasar a mixed; mantener respaldo y medir publicaciones reales. No se ha realizado ninguno de esos pasos remotos.
