import { describe, expect, it } from "vitest";
import { splitStatements } from "../src/lib/sql.ts";

describe("troceado de SQL", () => {
  it("separa sentencias corrientes", () => {
    expect(splitStatements("create table a (i int); create index b on a (i);")).toEqual([
      "create table a (i int)",
      "create index b on a (i)",
    ]);
  });

  it("no corta por un punto y coma dentro de una cadena", () => {
    const s = splitStatements("insert into t values ('hola; adios'); select 1;");
    expect(s).toHaveLength(2);
    expect(s[0]).toContain("hola; adios");
  });

  it("entiende el escape de comilla doblada", () => {
    const s = splitStatements("insert into t values ('l''hora; ya'); select 1;");
    expect(s).toHaveLength(2);
  });

  it("no corta dentro de un identificador entrecomillado", () => {
    expect(splitStatements('create table "raro; nombre" (i int);')).toHaveLength(1);
  });

  it("no corta dentro de un cuerpo con etiqueta de dolar", () => {
    const cuerpo = "create function f() returns int as $$ begin; return 1; end; $$ language plpgsql;";
    expect(splitStatements(cuerpo)).toHaveLength(1);
  });

  it("descarta los comentarios y no los cuenta como sentencia", () => {
    const s = splitStatements("-- comentario; con punto y coma\nselect 1;\n/* otro; aqui */\nselect 2;");
    expect(s).toHaveLength(2);
    expect(s[0]).toBe("select 1");
  });

  it("no devuelve sentencias vacias por punto y coma de sobra", () => {
    expect(splitStatements(";;\nselect 1;;\n")).toEqual(["select 1"]);
  });

  it("admite la ultima sentencia sin punto y coma final", () => {
    expect(splitStatements("select 1")).toEqual(["select 1"]);
  });
});
