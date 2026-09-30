import { ComponentBindings, type ManifestDeclaration, type ParsedSelector, SelectorParser } from "ng-js-compiler";
import { type DefaultTreeAdapterMap, parseFragment, serialize } from "parse5";

type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];

interface Matcher extends ParsedSelector {
  declaration: ManifestDeclaration;
}

/** Un atributo reservado (`disabled=`, `disabled>`): si no aparece, no hace falta parsear el template. */
const RESERVED_ATTRIBUTE = new RegExp(`(^|[\\s"':_-])(${Object.keys(ComponentBindings.RESERVED_INPUTS).join("|")})(\\s*=|[\\s/>])`, "i");

/**
 * Traduce, en un template, los atributos booleanos nativos escritos como binding (`disabled="x"`) a la directiva de
 * AngularJS que los enlaza (`ng-disabled="x"`, ver `ComponentBindings.RESERVED_INPUTS`) — como `[disabled]="x"` en
 * Angular, tanto para el input de un componente (el compilador lo registra con ese atributo) como para la propiedad
 * de un elemento nativo. Queda igual: un output (lo saca del DOM el compilador), un input `@` (atributo estático, como
 * en Angular) y, en un nativo, el atributo estático (`disabled`, `disabled=""`, `disabled="disabled"`) o interpolado.
 */
export interface RewriteOptions {
  /** Validar los `@Input({ required: true })` (por defecto sí). */
  checkRequired?: boolean;
}

export class TemplateRewriter {
  /** Hay algún `@Input({ required: true })`: todo template se recorre para validarlo, aunque no haya nada que traducir. */
  private readonly hasRequired: boolean;
  private checkRequired = true;

  private constructor(private readonly matchers: Matcher[]) {
    this.hasRequired = matchers.some((matcher) => matcher.declaration.inputs.some((input) => input.required));
  }

  static from(declarations: ManifestDeclaration[]): TemplateRewriter {
    const matchers = declarations.flatMap((declaration) => {
      try {
        return SelectorParser.parse(declaration.selector).map((parsed) => ({ ...parsed, declaration }));
      } catch {
        return []; // Un selector que el compilador no soporta tampoco se registra.
      }
    });
    return new TemplateRewriter(matchers);
  }

  /**
   * El template reescrito, o `undefined` si no hay nada que traducir (queda el original, byte por byte). Un elemento
   * que usa un componente/directiva sin uno de sus inputs `required` es error, como en el compilador de Angular.
   */
  rewrite(html: string, options: RewriteOptions = {}): string | undefined {
    this.checkRequired = this.hasRequired && options.checkRequired !== false;
    if (!this.checkRequired && !RESERVED_ATTRIBUTE.test(html)) return undefined;
    const fragment = parseFragment(html);
    return this.walk(fragment) ? serialize(fragment) : undefined;
  }

  private walk(parent: ParentNode): boolean {
    let changed = false;
    for (const node of parent.childNodes) {
      if (!("tagName" in node)) continue;
      if (this.rewriteElement(node)) changed = true;
      if (this.walk(node)) changed = true;
      if (node.tagName === "template" && this.walk((node as Element & { content: ParentNode }).content)) changed = true;
    }
    return changed;
  }

  private rewriteElement(element: Element): boolean {
    const attributes = element.attrs.map((attr) => TemplateRewriter.normalize(attr.name));
    const declarations = [
      ...new Set(this.matchers.filter((matcher) => TemplateRewriter.matches(matcher, element, attributes)).map((matcher) => matcher.declaration)),
    ];
    if (this.checkRequired) TemplateRewriter.assertRequired(element, attributes, declarations);

    let changed = false;
    for (const attr of element.attrs) {
      const name = TemplateRewriter.normalize(attr.name);
      const target = ComponentBindings.reservedAttribute(name);
      if (!target || attributes.includes(target)) continue;
      const asInput = declarations.some((declaration) => declaration.inputs.some((input) => input.name === name && input.mode === "<"));
      // Si otra declaración del elemento usa el mismo nombre como output o input `@`, el atributo es suyo también.
      const otherwise = declarations.some(
        (declaration) =>
          declaration.outputs.some((output) => output.name === name) || declaration.inputs.some((input) => input.name === name && input.mode === "@"),
      );
      if (otherwise) continue;
      if (asInput) {
        // Como un atributo estático sobre un input en Angular (`<x disabled>` → `""`): el valor vacío llega como string.
        if (attr.value.trim() === "") attr.value = "''";
      } else if (!ComponentBindings.BOOLEAN_ATTRIBUTES.has(name) || !TemplateRewriter.isBinding(name, attr.value)) {
        // En un nativo, `id`/`title` son texto estático (su binding es `ng-attr-title="{{ x }}"`, como siempre).
        continue;
      }
      attr.name = TemplateRewriter.kebab(target);
      changed = true;
    }
    return changed;
  }

  /** Cada input `required` de lo que matchea el elemento tiene que estar como atributo (o como su `ng-*` reservado). */
  private static assertRequired(element: Element, attributes: string[], declarations: ManifestDeclaration[]): void {
    for (const declaration of declarations) {
      for (const input of declaration.inputs) {
        if (!input.required) continue;
        const reserved = input.mode === "<" ? ComponentBindings.reservedAttribute(input.name) : undefined;
        if (attributes.includes(input.name) || (reserved !== undefined && attributes.includes(reserved))) continue;
        throw new Error(
          `<${element.tagName}>: falta el input requerido "${input.name}" de ${declaration.className} (${TemplateRewriter.kebab(input.name)}="...").`,
        );
      }
    }
  }

  /** En un nativo: `disabled`/`disabled=""`/`disabled="disabled"` es HTML estático; `{{ }}` es otra cosa. */
  private static isBinding(name: string, value: string): boolean {
    const trimmed = value.trim();
    return trimmed !== "" && trimmed.toLowerCase() !== name.toLowerCase() && !trimmed.includes("{{");
  }

  private static matches(matcher: Matcher, element: Element, attributes: string[]): boolean {
    if (matcher.restrict === "E") return element.tagName === TemplateRewriter.kebab(matcher.registrationName);
    return attributes.includes(matcher.registrationName) && (!matcher.requiredTag || element.tagName === matcher.requiredTag.toLowerCase());
  }

  /** Como `directiveNormalize` de AngularJS: sin `data-`/`x-`, separadores `:`/`-`/`_` → camelCase. */
  private static normalize(name: string): string {
    return name
      .replace(/^(?:x|data)[:\-_]/i, "")
      .toLowerCase()
      .replace(/[:\-_]+(.)/g, (_match, char: string) => char.toUpperCase());
  }

  private static kebab(name: string): string {
    return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
  }
}
