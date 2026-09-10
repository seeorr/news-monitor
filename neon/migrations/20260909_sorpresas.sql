-- La sorpresa deja de ser una sola.
--
-- Hasta hoy `computeSurprise()` elegia UNA base por orden de preferencia
-- —consenso, dato anterior, media de 3 meses— y tiraba el resto, y el esquema
-- estaba hecho a esa medida: `surprise_value` + `surprise_basis`, dos columnas
-- donde solo cabe una cifra. El problema es que FRED no publica consenso, asi
-- que `consensus` esta a null casi siempre y lo que se guardaba era la
-- comparacion contra el dato anterior, que no es una sorpresa sino una
-- variacion: el mercado ya se sabia el dato anterior. La media de 3 meses
-- responde a otra pregunta —si el dato se sale de la tendencia reciente— y no
-- sustituye a ninguna de las otras dos. Ahora se guardan todas las que se
-- pueden calcular.
--
-- POR QUE UN JSONB Y NO MAS COLUMNAS
--
-- La alternativa era un par de columnas por base: `surprise_previous_value`,
-- `surprise_mean3m_value`, `surprise_consensus_value` y sus unidades. Se
-- descarta por tres motivos, en este orden:
--
-- 1. La cardinalidad es variable y no la decide el esquema. Un evento macro
--    lleva dos bases, uno con consenso tecleado a mano lleva tres y una noticia
--    ninguna. Con columnas fijas, "ninguna" y "esa base no se pudo calcular" se
--    escriben igual —null— y la lista deja de poder distinguirlos; con un array
--    vacio se distinguen sin ambiguedad.
-- 2. Anadir una base cuarta (media de 6 meses, misma epoca del ano anterior)
--    seria una migracion mas DOS columnas mas y tocar los cinco sitios que
--    escriben o leen la fila. Con el array es una entrada mas en
--    `computeSurprises()` y nada mas: el esquema no se entera.
-- 3. Ya hay precedente y funciona: `alerts.analysis` (20260909_salida_del_analisis)
--    guarda una estructura de cardinalidad variable en un jsonb por el mismo
--    motivo, y se consulta con los operadores de Postgres sin haber montado
--    tres tablas que nadie iba a consultar.
--
-- Lo que se pierde con el jsonb es el tipado de la columna: `basis` podria
-- llevar cualquier texto. Se compensa donde importa —el `check` de aqui abajo
-- exige que sea un array, y `src/db/lectura.ts` valida cada elemento contra el
-- esquema de zod al leer, igual que ya hace con `analysis`—. Un indice GIN no
-- se pone: hoy no hay ninguna consulta que filtre por base, y un indice sobre
-- una tabla de este tamano no acelera nada y se paga en cada insert. El dia que
-- exista "ensename los datos que se salieron de su media de 3 meses", se anade
-- en una linea y `surprises @> '[{"basis":"mean_3m"}]'` lo usa.
--
-- IDEMPOTENTE, como todas: `add column if not exists`, el `check` guardado por
-- `pg_constraint`, y el relleno acotado por `surprises is null`, que lo
-- convierte en un no-op desde la segunda ejecucion.
--
-- Va detras de `20260909_salida_del_analisis.sql` por orden alfabetico, que es
-- el orden en que las aplica el migrador ('o' > 'a' en la cuarta letra).

alter table events add column if not exists surprises jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_surprises_es_lista'
  ) then
    alter table events add constraint events_surprises_es_lista
      check (surprises is null or jsonb_typeof(surprises) = 'array');
  end if;
end $$;

-- Las filas que ya existen se traen su unica sorpresa a la lista. No se inventa
-- nada: es el mismo valor con la misma base, movido de dos columnas a un array
-- de un elemento. Las bases que no se calcularon en su dia siguen sin estar,
-- porque los datos de entrada con los que se calcularon ya no se conservan y
-- reconstruirlas seria fabricarlas.
--
-- La unidad sale de `events.unit`, que es de donde salia cuando se escribio la
-- fila: `toEvent()` pasa `spec.unit` a las dos. Si la fila no tiene unidad se
-- guarda la cadena vacia, que es lo que el contrato admite y lo que la funcion
-- que escribe la sorpresa interpreta como "sin unidad".
update events
set surprises = jsonb_build_array(
      jsonb_build_object(
        'value', surprise_value,
        'basis', surprise_basis,
        'unit',  coalesce(unit, '')
      )
    )
where surprises is null
  and surprise_value is not null
  and surprise_basis is not null;

-- Y las que no tenian ninguna, tampoco tienen ninguna ahora: lista vacia y no
-- null, para que "este evento no tiene sorpresas" y "esta fila es anterior a la
-- migracion" no se escriban igual.
update events
set surprises = '[]'::jsonb
where surprises is null;

-- Las dos columnas viejas se quedan donde estan —ninguna migracion de este
-- proyecto borra nada— pero dejan de escribirse: `src/db/neon.ts` ya no las
-- incluye en el insert. Se dice aqui, en la propia base, porque dentro de seis
-- meses una columna a medio rellenar sin explicacion parece un fallo de datos.
comment on column events.surprise_value is
  'Historica. Sustituida por events.surprises (jsonb) el 2026-09-09. Solo tiene valor en las filas anteriores a esa fecha, ya copiadas al array. No se escribe desde entonces: no la leas para nada nuevo.';
comment on column events.surprise_basis is
  'Historica. Sustituida por events.surprises (jsonb) el 2026-09-09. Ver el comentario de events.surprise_value.';
comment on column events.surprises is
  'Todas las sorpresas calculables del evento, de mas a menos informativa: consenso, dato anterior, media de 3 periodos. Cada elemento es {value, basis, unit} y declara SIEMPRE su base. Array vacio = no habia nada contra lo que comparar.';
