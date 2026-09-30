import { parseSync } from "@swc/core";
import MagicString from "magic-string";

/** Source map v3 del código transformado al que se recibió (`sources` = el path del archivo). */
export interface SourceMapV3 {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: string[];
  names: string[];
  mappings: string;
}

/** El código transformado con su source map — la forma que junta el pipeline (`TransformChain` del compilador). */
export interface MappedOutput {
  code: string;
  map: SourceMapV3;
}

/** Un `template: "…"` o `templateUrl: "…"` del código, con el string ya decodificado. */
export interface TemplateLiteral {
  kind: "template" | "templateUrl";
  /** Offsets del literal completo (comillas incluidas) en el string del código. */
  start: number;
  end: number;
  quote: '"' | "'" | "`";
  value: string;
}

const PROPERTY = /\b(template|templateUrl)\s*:\s*/g;
/** Un string con un elemento HTML adentro (`<button …>`, `<ngb-rating …>`). */
const MARKUP = /<[a-z][\w-]*[\s/>]/i;

type AstNode = {
  type?: string;
  span?: { start: number; end: number };
  value?: string;
  quasis?: { cooked?: string | null }[];
  expressions?: unknown[];
};

/**
 * Los `template`/`templateUrl` con un string literal (un template literal con `${…}` es dinámico: queda afuera) — de
 * un `@Component` o de cualquier otro objeto (un estado de router, un `.component()` legacy): todos terminan en
 * `$compile`. `replace` los reescribe conservando la comilla y el escape.
 */
export class CodeTemplates {
  static find(code: string): TemplateLiteral[] {
    const found: TemplateLiteral[] = [];
    for (const match of code.matchAll(PROPERTY)) {
      const start = match.index + match[0].length;
      const literal = CodeTemplates.readLiteral(code, start);
      if (literal) found.push({ kind: match[1] as TemplateLiteral["kind"], start, ...literal });
    }
    return found;
  }

  /**
   * Todo string literal del código que sea markup (un template literal con `${…}` es dinámico: queda afuera) — para
   * los templates que un spec arma en variables o pasa a `$compile`/helpers en runtime, fuera de un `template:`.
   */
  static findMarkup(code: string): TemplateLiteral[] {
    if (!MARKUP.test(code)) return [];
    let ast: unknown;
    try {
      ast = parseSync(code, { syntax: "typescript", decorators: true, target: "es2022" });
    } catch {
      return []; // El que sigue en el pipeline reporta el error de sintaxis.
    }
    const bytes = Buffer.from(code, "utf8");
    // Los `Span` de `@swc/core` son offsets en BYTES UTF-8 desde `BytePos(1)`; el código se edita por índice de string.
    const charIndex = (bytePos: number) => bytes.subarray(0, bytePos - 1).toString("utf8").length;
    const found: TemplateLiteral[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const current = node as AstNode;
      const value =
        current.type === "StringLiteral"
          ? current.value
          : current.type === "TemplateLiteral" && current.expressions?.length === 0
            ? (current.quasis?.[0]?.cooked ?? undefined)
            : undefined;
      if (value !== undefined && current.span && MARKUP.test(value)) {
        const start = charIndex(current.span.start);
        found.push({ kind: "template", start, end: charIndex(current.span.end), quote: code[start] as TemplateLiteral["quote"], value });
        return;
      }
      for (const child of Object.values(current)) visit(child);
    };
    visit(ast);
    return found;
  }

  /** Reemplaza los literales dados (con su `value` nuevo), de atrás para adelante para no correr los offsets. */
  static replace(code: string, literals: TemplateLiteral[]): string {
    return CodeTemplates.replaceMapped(code, "", literals).code;
  }

  /**
   * `replace()` con su source map: un template de varias líneas que se reescribe en otra cantidad de líneas no corre
   * al resto del componente (lo que sigue en el pipeline junta este mapa con el suyo).
   */
  static replaceMapped(code: string, path: string, literals: TemplateLiteral[]): MappedOutput {
    const text = new MagicString(code);
    for (const literal of literals) text.overwrite(literal.start, literal.end, CodeTemplates.encode(literal.value, literal.quote));
    const map = text.generateMap({ source: path, hires: true, includeContent: true });
    return { code: text.toString(), map: JSON.parse(map.toString()) as SourceMapV3 };
  }

  private static readLiteral(code: string, start: number): Omit<TemplateLiteral, "kind" | "start"> | undefined {
    const quote = code[start];
    if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
    let raw = "";
    for (let index = start + 1; index < code.length; index++) {
      const char = code[index]!;
      if (char === "\\") {
        raw += char + (code[index + 1] ?? "");
        index++;
        continue;
      }
      if (quote === "`" && char === "$" && code[index + 1] === "{") return undefined;
      if (char === quote) return { end: index + 1, quote, value: CodeTemplates.decode(raw) };
      raw += char;
    }
    return undefined;
  }

  private static decode(raw: string): string {
    const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\n": "", "\r": "" };
    return raw.replace(/\\(.)/gs, (_match, char: string) => escapes[char] ?? char);
  }

  private static encode(value: string, quote: TemplateLiteral["quote"]): string {
    let body = value.replace(/\\/g, "\\\\");
    body =
      quote === "`"
        ? body.replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
        : body.replace(new RegExp(quote, "g"), `\\${quote}`).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    return `${quote}${body}${quote}`;
  }
}
