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

```yaml
path:
  - /path/to/repos
  - /path/to/other-repos
ignore:
  - old-repo
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

### 3. Cross dependencies

If repository **A** depends on repository **B** (both reviewed) and A's `package.json` declares B with a version lower than B's local version, A has an outdated dependency. `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies` are checked; the declared version is the minimum of the range (`^1.2.0` is lower than `1.3.0` even if the range allows it).

If a package name is in more than one reviewed repository, it is reported and that name is not used for cross dependencies nor for the order.

### 4. Contaminated installation

For each dependency in `node_modules`:

* **`npm link`:** `node_modules/<package>` is a symbolic link.
* **Copy (`devel-sync` or other):** the content of `node_modules/<package>` does not match the published package of the version recorded in `package-lock.json`. Only packages that are reviewed repositories are checked (the only ones copied during development). It takes into account that, when installing, npm changes CRLF to LF in the shebang of the executables declared in `bin`.

### 5. Cleanup order

With the untidy repositories and those that depend on them (even if they are clean) a topological order is built: first the ones that do not depend on any other repository of the list. For each repository the reason it is on the list is shown (its own problems, or which dependency forces it to be updated).

The order uses `dependencies`, `optionalDependencies` and `peerDependencies`, not `devDependencies`: among one's own packages they form cycles (for example, qa-control is a devDependency of libraries it depends on). If there is still a cycle, its members are placed in the same step and the cycle is shown.

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
