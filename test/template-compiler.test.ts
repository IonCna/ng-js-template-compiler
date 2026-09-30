import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { TemplateCompiler } from "@/template-compiler.ts";

describe("TemplateCompiler", () => {
  let dir: string;
  let src: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ngjs-template-compiler-test-"));
    src = join(dir, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    await writeFile(
      join(src, "rating.component.ts"),
      `import { Component, Input } from "ngjs-core";

@Component({ selector: "app-rating", template: "<span></span>" })
export class RatingComponent {
  @Input() disabled = false;
}
`,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("template inline: reescribe el string en el código", async () => {
    const compiler = TemplateCompiler.create(src);
    const code = `@Component({ selector: "app-host", template: \`<app-rating disabled="$.off"></app-rating>\` })\nexport class Host {}`;
    expect((await compiler.transform(code, join(src, "host.component.ts")))?.code).toBe(
      `@Component({ selector: "app-host", template: \`<app-rating ng-disabled="$.off"></app-rating>\` })\nexport class Host {}`,
    );
  });

  it("templateUrl: no inlinea — escribe el .html reescrito en el cache y apunta el templateUrl ahí", async () => {
    const cacheDir = join(dir, "cache");
    const compiler = TemplateCompiler.create(src, { cacheDir });
    await writeFile(join(src, "host.component.html"), `<app-rating disabled="$.off"></app-rating>`);
    const path = join(src, "host.component.ts");
    const output = (await compiler.transform(`@Component({ selector: "app-host", templateUrl: "./host.component.html" })\nexport class Host {}`, path))?.code;

    const url = /templateUrl: "([^"]+)"/.exec(output!)![1]!;
    expect(url.startsWith("../cache/")).toBe(true);
    expect(await readFile(resolve(dirname(path), url), "utf8")).toBe(`<app-rating ng-disabled="$.off"></app-rating>`);
    expect(compiler.ownersOf(join(src, "host.component.html"))).toEqual([path]);
    // El original no se toca.
    expect(await readFile(join(src, "host.component.html"), "utf8")).toBe(`<app-rating disabled="$.off"></app-rating>`);

    // Sin `./` también es relativo al componente (como lo resuelve el pipeline).
    const bare = (await compiler.transform(`@Component({ selector: "app-host", templateUrl: "host.component.html" })\nexport class Host {}`, path))?.code;
    expect(/templateUrl: "([^"]+)"/.exec(bare!)![1]).toBe(url);
  });

  it("en un spec reescribe todo string con markup (variables, $compile, helpers), no solo `template:`", async () => {
    const compiler = TemplateCompiler.create(src);
    const code = [
      `// ñ: un comentario con tildes antes no corre los offsets`,
      `const html = \`<app-rating disabled="off"></app-rating>\`;`,
      `$compile('<button disabled="!ok">Go</button>')(scope);`,
      `setup("<app-rating disabled></app-rating>", { size: \`\${size}\` });`,
      `expect(label).toBe("disabled=off");`,
    ].join("\n");

    expect((await compiler.transform(code, join(src, "rating.component.spec.ts")))?.code).toBe(
      [
        `// ñ: un comentario con tildes antes no corre los offsets`,
        `const html = \`<app-rating ng-disabled="off"></app-rating>\`;`,
        `$compile('<button ng-disabled="!ok">Go</button>')(scope);`,
        `setup("<app-rating ng-disabled=\\"''\\"></app-rating>", { size: \`\${size}\` });`,
        `expect(label).toBe("disabled=off");`,
      ].join("\n"),
    );
    // Fuera de un spec, solo `template:`/`templateUrl:`.
    expect((await compiler.transform(code, join(src, "rating.helper.ts")))?.code).toBeUndefined();
  });

  it("sin nada que traducir no cambia el código (ni el templateUrl)", async () => {
    const compiler = TemplateCompiler.create(src);
    await writeFile(join(src, "plain.component.html"), `<input disabled="disabled">`);
    const code = `@Component({ selector: "app-plain", templateUrl: "./plain.component.html", template2: "x" })\nexport class Plain {}`;
    expect((await compiler.transform(code, join(src, "plain.component.ts")))?.code).toBeUndefined();
  });

  it("un .ts con decoradores que cambia relee las declaraciones del proyecto", async () => {
    const compiler = TemplateCompiler.create(src);
    const host = join(src, "host.component.ts");
    const code = `@Component({ selector: "app-host", template: "<app-switch open=\\"$.toggle()\\"></app-switch>" })\nexport class Host {}`;
    // Sin declaración, `<app-switch>` es un elemento más: `open="expr"` es el binding de la propiedad.
    expect((await compiler.transform(code, host))?.code).toContain(`ng-open=\\"$.toggle()\\"`);

    const switchPath = join(src, "switch.component.ts");
    const switchCode = `import { Component, Output } from "ngjs-core";\n@Component({ selector: "app-switch", template: "" })\nexport class SwitchComponent { @Output() open; }\n`;
    await writeFile(switchPath, switchCode);
    await compiler.transform(switchCode, switchPath);

    // Ahora `open` es un output: queda igual.
    expect((await compiler.transform(code, host))?.code).toBeUndefined();
  });

  it("devuelve un source map: el template reescrito no corre al resto del componente", async () => {
    const compiler = TemplateCompiler.create(src);
    const path = join(src, "host.component.ts");
    const code = [
      "@Component({",
      '  selector: "app-host",',
      "  template: `",
      '    <app-rating disabled="busy"></app-rating>',
      "  `,",
      "})",
      "export class Host {",
      '  fail(): never { throw new Error("boom"); }',
      "}",
    ].join("\n");

    const output = (await compiler.transform(code, path))!;
    expect(output.code).toContain('ng-disabled="busy"');

    const lines = output.code.split("\n");
    const line = lines.findIndex((text) => text.includes("boom")) + 1;
    const position = originalPositionFor(new TraceMap(output.map as never), { line, column: lines[line - 1]!.indexOf("boom") });
    expect(position.line).toBe(8);
    expect(output.map.sourcesContent).toEqual([code]);
  });
});

