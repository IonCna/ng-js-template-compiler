import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CodeTemplates, type MappedOutput, type TemplateLiteral } from "@/code-templates.ts";
import { DeclarationRegistry } from "@/declaration-registry.ts";

export interface TemplateCompilerOptions {
  /** Dónde van los `.html` reescritos de un `templateUrl`; por defecto `node_modules/.ngjs/templates` del proyecto. */
  cacheDir?: string;
}

/**
 * Transform del pipeline de ngjs (`{ transform(code, path) }`), independiente de los demás: reescribe los templates
 * de cada `.ts` con `TemplateRewriter`. Un `template` inline se reescribe en el código; un `templateUrl` relativo NO
 * se inlinea — el `.html` reescrito se escribe en `cacheDir` y el `templateUrl` pasa a apuntar ahí (el que sigue en el
 * pipeline lee un `templateUrl` como cualquier otro). Un template sin nada que traducir queda intacto.
 */
export class TemplateCompiler {
  private readonly registry: DeclarationRegistry;
  private readonly cacheDir: string;
  private readonly projectDir: string;
  /** `.html` original → los `.ts` que lo usan (para `ownersOf`). */
  private readonly owners = new Map<string, Set<string>>();

  private constructor(roots: string[], options: TemplateCompilerOptions) {
    this.registry = new DeclarationRegistry(roots);
    this.projectDir = TemplateCompiler.findProjectDir(roots[0]!);
    this.cacheDir = options.cacheDir ?? join(this.projectDir, "node_modules", ".ngjs", "templates");
  }

  static create(sourceRoot: string | string[], options: TemplateCompilerOptions = {}): TemplateCompiler {
    return new TemplateCompiler((Array.isArray(sourceRoot) ? sourceRoot : [sourceRoot]).map((root) => resolve(root)), options);
  }

  async transform(code: string, path: string): Promise<MappedOutput | undefined> {
    if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return undefined;
    this.registry.observe(path, code);
    const literals = CodeTemplates.find(code);
    // Un spec arma templates en variables o los pasa a `$compile`/helpers en runtime: todo string con markup.
    if (/\.(spec|test)\.ts$/.test(path)) {
      const taken = new Set(literals.map((literal) => literal.start));
      literals.push(...CodeTemplates.findMarkup(code).filter((literal) => !taken.has(literal.start)));
    }
    if (literals.length === 0) return undefined;

    const rewriter = await this.registry.rewriter();
    const changed: TemplateLiteral[] = [];
    for (const literal of literals) {
      if (literal.kind === "template") {
        const html = rewriter.rewrite(literal.value);
        if (html !== undefined) changed.push({ ...literal, value: html });
        continue;
      }
      const source = this.templatePath(literal.value, path);
      if (!source) continue;
      this.own(source, path);
      const html = await readFile(source, "utf8").catch(() => undefined);
      const rewritten = html === undefined ? undefined : rewriter.rewrite(html);
      if (rewritten === undefined) continue;
      changed.push({ ...literal, value: TemplateCompiler.relativeUrl(path, await this.writeCache(source, rewritten)) });
    }
    return changed.length ? CodeTemplates.replaceMapped(code, path, changed) : undefined;
  }

  /** Como lo resuelve el pipeline: relativo al `.ts` (con o sin `./`); `/…` y `src/…` desde el proyecto; no una URL. */
  private templatePath(url: string, owner: string): string | undefined {
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return undefined;
    if (url.startsWith("/")) return join(this.projectDir, url.slice(1));
    if (url.startsWith("src/")) return join(this.projectDir, url);
    return resolve(dirname(owner), url);
  }

  /** Los `.ts` cuyo `templateUrl` es `file` (el original): al editarlo se los da por cambiados (`ngjs serve`). */
  ownersOf(file: string): string[] {
    return [...(this.owners.get(resolve(file)) ?? [])];
  }

  private own(source: string, owner: string): void {
    const owners = this.owners.get(source) ?? new Set<string>();
    owners.add(owner);
    this.owners.set(source, owners);
  }

  /** Determinista por `.html` original (mismo nombre de archivo): el scope de `ng-js-vite` sale del path. */
  private async writeCache(source: string, html: string): Promise<string> {
    const target = join(this.cacheDir, createHash("sha256").update(source).digest("hex").slice(0, 8), basename(source));
    if ((await readFile(target, "utf8").catch(() => undefined)) !== html) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, html, "utf8");
    }
    return target;
  }

  private static relativeUrl(from: string, target: string): string {
    const url = relative(dirname(from), target).split(sep).join("/");
    return url.startsWith(".") ? url : `./${url}`;
  }

  private static findProjectDir(root: string): string {
    for (let dir = root; ; dir = dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) return dir;
      if (dirname(dir) === dir) return root;
    }
  }
}
