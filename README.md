# patchbay

Patches that run Koishi, Satori, the Satori adapters and a few Cordis plugins on **Cordis 4**, kept in one place and wired into yarn, pnpm or npm by one command.

Each patch targets one exact upstream version listed in [`patchbay.json`](patchbay.json). Nothing is republished: your package manager installs the upstream tarball and applies the patch from this package.

## Use

```sh
npm i -D @chatluna/patchbay      # or yarn add -D / pnpm add -D
npx patchbay sync                # writes .patchbay/ and the package-manager config
npm install                      # or yarn install / pnpm install
```

Commit `.patchbay/` together with the config `sync` writes. Run `patchbay sync` again after upgrading patchbay. It replaces every pin the previous version wrote.

| Package manager | What `sync` writes                                                                             | When patches apply         |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| Yarn 2+         | `resolutions` → `patch:<pkg>@npm:<version>#~/.patchbay/<pkg>@<version>.patch`                  | on install                 |
| pnpm 10+        | `pnpm-workspace.yaml`: `overrides`, `patchedDependencies`, `allowUnusedPatches`                | on install                 |
| npm             | `overrides`, direct dependencies pinned to the same spec, `postinstall: patchbay apply`        | after install, in place    |

`sync` reads the package manager from `packageManager`, then the lockfile, then the one running it. Pass `--pm yarn|pnpm|npm` to choose it yourself. Yarn 1 has no patch support and is rejected.

Every patched package is pinned to its patched version, along with these aliases:

- `koishi` → `@koishijs/core`
- `minato` → `@cordisjs/plugin-database`

A plugin that later installs one of them gets the patched build.

On npm, `patchbay apply` keeps a copy of the patch it applied in each package (`.patchbay.patch`). It skips packages that are already current and undoes an older patch before applying a newer one.

### From code

```ts
import { apply, sync } from '@chatluna/patchbay'

const pm = sync(projectDir) // 'yarn' | 'pnpm' | 'npm'
// ...run the install...
if (pm === 'npm') apply(projectDir)
```

## Maintain

```sh
yarn refresh edit <name>     # unpack upstream to .work/<pkg>/{a,b}, current patch applied to b
# edit .work/<pkg>/b
yarn refresh commit <name>   # diff a → b into patches/<pkg>@<version>.patch
yarn verify                  # every patch applies to its upstream tarball
yarn test                    # unit tests plus real yarn, pnpm and npm installs
```

To patch a new package or version, add its entry to `patchbay.json`, run `yarn refresh edit <name>`, make the change, then commit it.

## License

MIT
