import type { ManifestDeclaration } from "ng-js-compiler";
import { describe, expect, it, vi } from "vitest";
import { TemplateRewriter } from "@/template-rewriter.ts";

const declarations: ManifestDeclaration[] = [
  {
    className: "LibRating",
    kind: "component",
    selector: "lib-rating",
    inputs: [
      { property: "disabled", name: "disabled", mode: "<" },
      { property: "readonly", name: "readonly", mode: "<" },
    ],
    outputs: [{ property: "rateChange", name: "rateChange" }],
  },
  {
    className: "LibToast",
    kind: "component",
    selector: "lib-toast",
    inputs: [{ property: "header", name: "header", mode: "@" }],
    outputs: [{ property: "hidden", name: "hidden" }],
  },
  {
    className: "LibNavLink",
    kind: "directive",
    selector: "a[libNavLink], button[libNavLink]",
    inputs: [{ property: "disabled", name: "disabled", mode: "<" }],
    outputs: [],
  },
  {
    className: "LibLabel",
    kind: "directive",
    selector: "[libLabel]",
    inputs: [{ property: "hidden", name: "hidden", mode: "@" }],
    outputs: [],
  },
  {
    className: "LibWindow",
    kind: "component",
    selector: "lib-window",
    inputs: [
      { property: "id", name: "id", mode: "<" },
      { property: "title", name: "title", mode: "<" },
    ],
    outputs: [],
  },
];

const rewriter = TemplateRewriter.from(declarations);

describe("TemplateRewriter", () => {
  it("traduce un input `<` reservado al atributo ng-* en el elemento que matchea la declaración", () => {
    expect(rewriter.rewrite(`<lib-rating disabled="$.off" readonly="true" rate="3"></lib-rating>`)).toBe(
      `<lib-rating ng-disabled="$.off" ng-readonly="true" rate="3"></lib-rating>`,
    );
    // Selector con tag requerido: en <button> matchea la directiva.
    expect(rewriter.rewrite(`<button lib-nav-link disabled="$.off"></button>`)).toBe(`<button lib-nav-link="" ng-disabled="$.off"></button>`);
    // Sobre un input, un atributo sin valor llega como string vacío (como en Angular).
    expect(rewriter.rewrite(`<lib-rating disabled></lib-rating>`)).toBe(`<lib-rating ng-disabled="''"></lib-rating>`);
  });

  it("en un elemento nativo traduce el binding y deja el atributo estático", () => {
    expect(rewriter.rewrite(`<fieldset disabled="$.disabled"><button hidden="!$.show" disabled="true"></button></fieldset>`)).toBe(
      `<fieldset ng-disabled="$.disabled"><button ng-hidden="!$.show" ng-disabled="true"></button></fieldset>`,
    );
    expect(rewriter.rewrite(`<input disabled><input disabled=""><option selected="selected"></option><input readonly="{{ x }}">`)).toBeUndefined();
    // `id`/`title` en un nativo son texto.
    expect(rewriter.rewrite(`<button id="main" title="Cerrar" disabled>x</button>`)).toBeUndefined();
  });

  it("id/title: se traducen solo como input de un componente", () => {
    expect(rewriter.rewrite(`<lib-window id="$.domId" title="$.heading"></lib-window>`)).toBe(
      `<lib-window ng-id="$.domId" ng-title="$.heading"></lib-window>`,
    );
  });

  it("deja igual un output, un input `@` y un ng-* ya escrito", () => {
    expect(rewriter.rewrite(`<lib-toast hidden="$.close()"></lib-toast>`)).toBeUndefined();
    expect(rewriter.rewrite(`<span lib-label hidden="$.x"></span>`)).toBeUndefined();
    expect(rewriter.rewrite(`<lib-rating ng-disabled="$.a" disabled="$.b"></lib-rating>`)).toBeUndefined();
  });

  it("recorre anidados y el contenido de <template>", () => {
    expect(rewriter.rewrite(`<div><template><lib-rating data-disabled="$.off"></lib-rating></template></div>`)).toBe(
      `<div><template><lib-rating ng-disabled="$.off"></lib-rating></template></div>`,
    );
  });

  describe("@Input({ required: true })", () => {
    const required = TemplateRewriter.from([
      {
        className: "LibCard",
        kind: "component",
        selector: "lib-card",
        inputs: [
          { property: "heading", name: "heading", mode: "<", required: true },
          { property: "disabled", name: "disabled", mode: "<", required: true },
          { property: "note", name: "note", mode: "<" },
        ],
        outputs: [],
      },
      {
        className: "LibTip",
        kind: "directive",
        selector: "[libTip]",
        inputs: [{ property: "libTip", name: "libTip", mode: "<", required: true }],
        outputs: [],
      },
    ]);

    it("un uso sin el atributo es error en build, como el compilador de Angular", () => {
      expect(() => required.rewrite(`<div><lib-card disabled="$.off"></lib-card></div>`)).toThrow(
        '<lib-card>: falta el input requerido "heading" de LibCard (heading="...").',
      );
    });

    it("con todos los requeridos (también como ng-* o data-*) no hay error; sin nada que traducir queda igual", () => {
      expect(required.rewrite(`<lib-card data-heading="$.title" ng-disabled="$.off"></lib-card>`)).toBeUndefined();
      expect(required.rewrite(`<lib-card heading="$.title" disabled="$.off"></lib-card>`)).toBe(
        `<lib-card heading="$.title" ng-disabled="$.off"></lib-card>`,
      );
      // El input que es el propio selector siempre está.
      expect(required.rewrite(`<span lib-tip="'hola'"></span>`)).toBeUndefined();
    });

    it("con checkRequired: false (el markup de un spec) no se valida", () => {
      expect(required.rewrite(`<lib-card></lib-card>`, { checkRequired: false })).toBeUndefined();
    });

    // `rewrite()` guarda su resultado por template: ni un error ni la otra variante de `checkRequired` salen de ahí.
    it("el resultado guardado de un template no tapa un error ni la validación de la otra variante", () => {
      const html = `<lib-card></lib-card>`;
      expect(required.rewrite(html, { checkRequired: false })).toBeUndefined();
      expect(() => required.rewrite(html)).toThrow('falta el input requerido "heading"');
      expect(() => required.rewrite(html)).toThrow('falta el input requerido "heading"');
      expect(required.rewrite(html, { checkRequired: false })).toBeUndefined();
    });
  });

  it("el mismo template da el mismo resultado sin volver a recorrerlo", () => {
    const rewriter = TemplateRewriter.from(declarations);
    const html = `<lib-rating disabled="$.off"></lib-rating>`;
    const first = rewriter.rewrite(html);
    const walk = vi.spyOn(rewriter as unknown as { walk: () => boolean }, "walk");

    expect(rewriter.rewrite(html)).toBe(first);
    expect(first).toBe(`<lib-rating ng-disabled="$.off"></lib-rating>`);
    expect(walk).not.toHaveBeenCalled();
  });

  describe("| async → | async:this (el filtro de ngjs-core necesita el scope)", () => {
    it("en interpolaciones y en atributos, sin tocar el resto del template", () => {
      expect(rewriter.rewrite(`<p class="x">{{ $.name$ | async }}</p>`)).toBe(`<p class="x">{{ $.name$ | async:this }}</p>`);
      expect(rewriter.rewrite(`<li ng-repeat="n in $.items$ | async track by n">{{n}}</li>`)).toBe(
        `<li ng-repeat="n in $.items$ | async:this track by n">{{n}}</li>`,
      );
      expect(rewriter.rewrite(`<b>{{ ($.total$|async) | currency }}</b>`)).toBe(`<b>{{ ($.total$|async:this) | currency }}</b>`);
    });

    it("con otro atributo reservado en el mismo template, hace las dos cosas", () => {
      expect(rewriter.rewrite(`<button disabled="$.busy$ | async">{{ $.label$ | async }}</button>`)).toBe(
        `<button ng-disabled="$.busy$ | async:this">{{ $.label$ | async:this }}</button>`,
      );
    });

    it("deja igual `||`, un async: ya escrito, otro pipe que empieza con async y el texto sin pipe", () => {
      expect(rewriter.rewrite(`<p>{{ $.a || async }}</p>`)).toBeUndefined();
      expect(rewriter.rewrite(`<p>{{ $.a$ | async:this }}</p>`)).toBeUndefined();
      expect(rewriter.rewrite(`<p>{{ $.a | asyncLabel }}</p>`)).toBeUndefined();
      expect(rewriter.rewrite(`<p>Carga async de datos</p>`)).toBeUndefined();
    });
  });
});

