-- Las notas que se quedaron solo en `alerts` vuelven a su evento.
--
-- `20260908_puntuacion.sql` creo las cuatro columnas en `events` pero nacieron a
-- null, que era lo correcto: nadie habia guardado esa nota ahi. Solo que en las
-- alertas ya enviadas si esta guardada, en `alerts`, y es el mismo numero del
-- mismo evento. Dejarla solo alli haria que "lo mas importante" ignorase
-- justamente lo unico que el sistema ha considerado importante hasta hoy.
--
-- Esto no inventa nada: copia un dato existente a la columna por la que ahora se
-- ordena. `one_liner` NO se rellena, porque `alerts` no lo guarda: lo que no
-- esta, sigue sin estar.
--
-- Idempotente como las demas, y por partida doble: el `is null` la convierte en
-- un no-op desde la segunda ejecucion, y ademas no puede pisar la nota que
-- escriba `mark()` de aqui en adelante.
--
-- Va detras de `20260908_puntuacion.sql` por orden alfabetico del nombre, que es
-- el orden en que las aplica el migrador.
update events e
set importance_score    = a.importance_score,
    market_impact_score = a.market_impact_score,
    sentiment           = a.sentiment
from alerts a
where a.event_id = e.id
  and e.importance_score is null;
