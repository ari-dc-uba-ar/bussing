# bussing


Reviews the local development environment after a task (or at any time) and detects the repositories left untidy: uncommitted or unpushed changes, versions not bumped or not published, outdated cross dependencies and installations contaminated by `npm link` or `devel-sync`. It also tells in which order to clean them up.


[![npm-version](https://img.shields.io/npm/v/bussing.svg)](https://npmjs.org/package/bussing)
[![downloads](https://img.shields.io/npm/dm/bussing.svg)](https://npmjs.org/package/bussing)
[![build](https://github.com/ari-dc-uba-ar/bussing/actions/workflows/build-and-test.yml/badge.svg)](https://github.com/ari-dc-uba-ar/bussing/actions/workflows/build-and-test.yml)
[![qa-control](https://github.com/ari-dc-uba-ar/bussing/actions/workflows/qa-control.yml/badge.svg)](https://github.com/ari-dc-uba-ar/bussing/actions/workflows/qa-control.yml)


language: ![English](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-en.png)
also available in:
[![Spanish](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-es.png)](LEEME.md)


## Reviewed repositories

The root folders are set with `--path` (it can be repeated). Every subfolder of a root folder that has a `package.json` is a repository to review, except those named as one of the values of `--ignore` (it can be repeated too).

## Default values

The optional file `~/.bussing.yaml` sets default values for the parameters; the keys are the parameter names (`bussing --help`). What is given in the command line takes precedence. Relative folders are relative to the current folder, as in the command line.

npm queries are kept in memory during the run. With `--cache <folder>` (or `cache` in the file) they are also stored on disk: package documents expire after `--cache-max-age` minutes (60 by default) and tarballs never expire.

```yaml
path:
  - /path/to/repos
  - /path/to/other-repos
ignore:
  - old-repo
priority:
  qa-control: 1
  require-bro: -1
```

## Checks

### 1. git

* There are uncommitted changes (including untracked files that are not ignored).
* There are unpushed commits.
* The current branch has no upstream.

### 2. Publication

The local `package.json` is compared with the npm registry:

* **Unpublished version:** the local version is greater than the last published one.
* **Version not bumped:** the local version equals the published one, but the local `HEAD` differs from the `gitHead` npm recorded when that version was published (there are commits after the publication).
* **Not published:** the package does not exist in npm.

Packages with `"private": true` are not checked.

### 3. Outdated dependencies

A dependency of **A** is outdated if the version declared in A's `package.json` is lower than:

* the version published in npm (for any dependency, own or not), or
* the version of the local copy, if the dependency is another reviewed repository (even if that version is not published yet).

The diagnosis shows both versions (`en npm 2.2.2, local 2.3.0`). The declared version is the minimum of the range (`^1.2.0` is lower than `1.3.0` even if the range allows it). The fields within the threshold are checked (see below).

The [npm-check-updates](https://www.npmjs.com/package/npm-check-updates) (`ncu`) configuration is respected: the `.ncurc`, `.ncurc.json`, `.ncurc.yaml` or `.ncurc.yml` files of the repository and, for what they do not define, those of the user's folder. `reject` and `filter` (excluded dependencies are not checked) and `target` (`latest`, `newest`, `greatest`, `minor`, `patch`, `semver` or `@tag`; `latest` by default) are used, both for the npm version and for the local one. `.ncurc.js`, `.mjs` and `.cjs` files contain code and are not interpreted.

If a package name is in more than one reviewed repository, it is reported and that name is not used for cross dependencies nor for the order.

### 4. Contaminated installation

For each dependency in `node_modules`:

* **`npm link`:** `node_modules/<package>` is a symbolic link.
* **Copy (`devel-sync` or other):** the content of `node_modules/<package>` does not match the published package of the version recorded in `package-lock.json`. Only packages that are reviewed repositories are checked (the only ones copied during development). It takes into account that, when installing, npm changes CRLF to LF in the shebang of the executables declared in `bin`.

### 5. Pending

With the untidy repositories a topological order is built: first the ones that do not depend on any other repository of the list. Those that depend on a repository whose problems reach its users also enter, marked as "by dependency" (with the field suffix): uncommitted or unpushed changes, version not bumped or not published, or outdated production, peer or optional dependencies. Outdated devDependencies and altered node_modules do not reach the package's users. For each repository the reason it is on the list is shown.

`dependencies`, `optionalDependencies` and `peerDependencies` are strong dependencies: they define which repositories enter the list and are always respected in the order. `devDependencies` are weak: they are respected unless they close a cycle, because among one's own packages they form cycles (for example, qa-control is a devDependency of libraries it depends on). Those that would close a cycle are deferred: the step shows it and that dependency stays outdated until a later review. With `--priority package=number` (it can be repeated; 0 by default) you decide which weak dependencies are respected first: higher numbers are respected earlier and lower numbers are the first to be deferred. If there is a cycle of strong dependencies, its members are placed in the same step and the cycle is shown.

Each step shows the most serious problem of the repository. From most to least serious (in parentheses, the key used by `--up-to` and the JSON): uncommitted changes (`uncommitted`), unpushed commits (`unpushed`), altered node_modules (`altered-node-modules`), then waiting for / outdated `dependencies`, `peerDependencies` and `optionalDependencies` (`waiting-dependencies`, `outdated-dependencies`, `waiting-peer-dependencies`, `outdated-peer-dependencies`, `waiting-optional-dependencies`, `outdated-optional-dependencies`; waiting means some outdated dependency has its own problems and comes earlier in the order), version not bumped (`version-not-bumped`), not published (`unpublished`), and finally waiting for / outdated `devDependencies` (`waiting-dev-dependencies`, `outdated-dev-dependencies`), which do not reach the package's users and are not needed to publish.

`--up-to <key>` chooses the least serious category of interest; less serious ones are not reported nor used for the order, and the checks that could only produce them are skipped (for example, without `version-not-bumped` npm is not queried). The default is `unpublished`, so devDependencies are not shown; `--dev` is the same as `--up-to outdated-dev-dependencies`. Both categories of a dependency field are included or excluded together. Dependencies outside the threshold (by default, devDependencies) do not define the step numbers, but they do order the repositories within each number, also using `--priority` to break cycles. Those that enter only because of their dependencies are marked as such.

## Usage

### Command line

```sh
bussing --path /path/to/repos --path /path/to/other-repos
bussing --json
```

It shows a readable report; with `--json` it shows the full report as JSON. The parameters and the exit codes are described in `bussing --help`.

### As a library

`bussing` can be included from another system. `reviewEnvironment` receives typed options and returns the typed report; it does not write to the output nor end the process.

```ts
import { reviewEnvironment } from 'bussing';

const report = await reviewEnvironment({ roots: ['/path/to/repos'] });
```


## License

[MIT](LICENSE)
