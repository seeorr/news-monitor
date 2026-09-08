-- La puntuacion deja de morirse con el evento que no llego a alertar.
--
-- Hasta ahora el paso 3 puntuaba todo lo que pasaba el filtro, pero solo
-- sobrevivia lo que superaba el umbral: `saveAlert` escribia la nota en
-- `alerts` y lo demas pasaba por `mark`, que solo toca `events`. Con el umbral
-- en 7, eso son unos pocos eventos al dia; el resto quedaba en la base como una
-- lista cronologica sin jerarquia, y cualquier "lo mas importante" ordenaba en
-- realidad el subconjunto de lo anunciado. Se pagaba el modelo y se tiraba el
-- resultado.
--
-- Idempotente como las demas, y se aplica sobre la base viva sin perder nada:
-- las cuatro columnas nacen anulables y sin valor por defecto, asi que Postgres
-- no reescribe ninguna fila existente. Las que ya estaban se quedan a null, que
-- es la verdad —nadie guardo su puntuacion— y no un 5 de relleno.
--
-- Va detras de `20260908_inicial.sql` por orden alfabetico del nombre, que es el
-- orden en que las aplica el migrador. Al elegir nombre para la siguiente,
-- mirar que siga cayendo despues de la que crea la tabla.
alter table events add column if not exists importance_score    integer;
alter table events add column if not exists market_impact_score integer;
alter table events add column if not exists sentiment           text;

-- La frase del paso 3. Es el unico resumen propio que tiene un evento no
-- anunciado: el titular lo escribe la fuente y el `summary` tambien.
alter table events add column if not exists one_liner           text;

-- "Lo importante" ordena por esto. `nulls last` no hace falta declararlo en el
-- indice porque en `desc` los nulos van primero, y la consulta que jerarquiza
-- filtra por `importance_score is not null`: un evento sin puntuar no compite.
create index if not exists events_por_importancia on events (importance_score desc, first_seen_at desc);
