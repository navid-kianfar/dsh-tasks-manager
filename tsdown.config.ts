/**
 * Standalone build for an out-of-tree dsh plugin. It reproduces the two artifact formats the
 * harness's own (unpublished) client preset emits, because a package outside that repository has to
 * produce them itself:
 *
 * 1. **Node half** — plain ESM. Every `@deepseek-ai/*` specifier stays an import so it resolves to
 *    the singletons the running dsh process already holds; a bundled copy would be a second
 *    registry.
 * 2. **Browser half** — a CJS closure the loader calls, wrapped in the exact
 *    `window.__ModuleLoader__.load({ id, factory })` handoff, resolving only the module-table
 *    baseline through the injected `require`. Everything else inlines, CSS Modules included.
 *
 * tsc runs first and tsdown bundles its output rather than the sources. This plugin has no
 * decorators of its own, but the two-step keeps declaration emit with tsc (which owns `types/`)
 * and matches the harness's own build shape.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { isBuiltin } from 'node:module'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** This package's name; stamped into the loader handoff and onto injected style tags. */
const ID = '@achasoft/dsh-tasks-manager'

/**
 * Specifiers the browser resolves through the loader's module table. Mirrors the harness's
 * `PLATFORM_MODULES` + `PRELOADED_CLIENT_EXTERNALS`; anything absent from it must inline, because a
 * `require()` the table cannot answer throws at factory time.
 */
const MODULE_TABLE = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

/** Directory tsc emits into; tsdown's real input. */
const TSC_OUT = 'tsbuild'

/**
 * Resolve an asset import against the sources, since the importer is an emitted `tsbuild` module
 * and stylesheets only exist under `src`.
 * @param source - the relative specifier as written.
 * @param importer - absolute path of the importing module.
 * @returns the stylesheet's real path.
 */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}${TSC_OUT}${sep}`
  const at = emitted.indexOf(marker)
  return at < 0 ? emitted : resolve(emitted.slice(0, at), 'src', emitted.slice(at + marker.length))
}

/** Virtual id keeping module CSS out of tsdown's own css pipeline; must not end in `.css`. */
const CSS_VIRTUAL = '\0dsh-css:'
const CSS_SUFFIX = '.mjs'

/**
 * Emit the style injector plus the hashed class map for one `*.module.css`.
 * @param file - absolute path of the stylesheet, whose basename tags the injected element.
 * @param css - the compiled, minified CSS text.
 * @param classMap - exported local name to emitted class list.
 * @returns the module source tsdown bundles in the stylesheet's place.
 */
function styleModule(file: string, css: string, classMap: Record<string, string>): string {
  const tagId = `${ID}/${file.split('/').pop() ?? file}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

const nodeHalf: UserConfig = {
  name: ID,
  entry: {
    index: `${TSC_OUT}/index.js`,
    host: `${TSC_OUT}/host/index.js`,
    tools: `${TSC_OUT}/tools/index.js`,
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  // tsc owns declarations (these entries are already-emitted JS, so tsdown has no TS to read).
  dts: false,
  clean: true,
  deps: {
    // The harness's own packages live in the running installation; keeping them imports is what
    // makes this plugin share its services rather than instantiate parallel ones.
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
    alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !specifier.startsWith('@deepseek-ai/'),
  },
}

const browserHalf: UserConfig = {
  name: `${ID}/client`,
  entry: { client: `${TSC_OUT}/client/index.js` },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  // The module table is the ONLY thing the injected `require` can answer, so it is also the only
  // legal external. `noExternal` is stated as well because tsdown otherwise externalizes production
  // dependencies, which in the browser half must inline instead.
  external: (specifier: string) => MODULE_TABLE.has(specifier),
  noExternal: [/^(?!react(-dom)?(\/|$)|@deepseek-ai\/).+/],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer === undefined ? source : sourceAssetPath(source, importer)
      return CSS_VIRTUAL + abs + CSS_SUFFIX
    },
    async load(this: { addWatchFile(id: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL)) return null
      const file = virtualId.slice(CSS_VIRTUAL.length, -CSS_SUFFIX.length)
      this.addWatchFile(file)
      const { code, exports: cssExports } = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) {
        // A `composes:` rule exports the composed base as a SEPARATE name; taking only `name` drops
        // the base class and the element renders with just the override rules. The map value is the
        // full class list, which is what CSS Modules means by one exported name.
        classMap[local] = [exported.name, ...exported.composes.map(entry => entry.name)].join(' ')
      }
      return styleModule(file, code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeHalf, browserHalf]
