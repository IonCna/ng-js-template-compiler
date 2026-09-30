import { resolve } from "node:path";
import { ApplicationScanner, LibraryManifest } from "ng-js-compiler";
import { TemplateRewriter } from "@/template-rewriter.ts";

const DECLARATION = /@(Component|Directive|Input|Output)\s*\(/;

/**
 * Las declaraciones que ve un template: las de las dependencias (su `ngjs-manifest.json`) y las del proyecto (leídas
 * de sus fuentes con `LibraryManifest.fromSources`, sin el `MetadataStore` global del compilador). Las del proyecto se
 * releen cuando cambia un `.ts` con decoradores (`ngjs serve`).
 */
export class DeclarationRegistry {
  private rewriterPromise?: Promise<TemplateRewriter>;
  private librariesPromise?: ReturnType<typeof LibraryManifest.fromDependencies>;
  private known = new Set<string>();
  private readonly sources = new Map<string, string>();

  constructor(private readonly roots: string[]) {}

  /** El código de un `.ts` que pasa por el pipeline: si cambió (o es nuevo) y declara algo, se relee el proyecto. */
  observe(path: string, code: string): void {
    const key = resolve(path);
    const previous = this.sources.get(key);
    this.sources.set(key, code);
    if (!this.rewriterPromise || previous === code) return;
    const changed = previous !== undefined || !this.known.has(key);
    if (changed && (DECLARATION.test(code) || (previous !== undefined && DECLARATION.test(previous)))) this.rewriterPromise = undefined;
  }

  rewriter(): Promise<TemplateRewriter> {
    this.rewriterPromise ??= this.build();
    return this.rewriterPromise;
  }

  private async build(): Promise<TemplateRewriter> {
    this.librariesPromise ??= LibraryManifest.fromDependencies(this.roots[0]!);
    const [libraries, project, files] = await Promise.all([
      this.librariesPromise,
      // El compilador reporta sus propios errores de escaneo: acá, sin las del proyecto.
      LibraryManifest.fromSources(this.roots).catch(() => ({ version: 1 as const, declarations: [] })),
      Promise.all(this.roots.map((root) => ApplicationScanner.listTsFiles(root))),
    ]);
    this.known = new Set(files.flat().map((file) => resolve(file)));
    return TemplateRewriter.from([...project.declarations, ...libraries]);
  }
}
