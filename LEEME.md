<!--multilang v0 es:LEEME.md en:README.md -->
# bussing

<!--lang:es-->

Revisa el ambiente local de desarrollo después de una tarea (o en cualquier momento) y detecta los repositorios que quedaron desprolijos: cambios sin commitear o sin pushear, versiones sin subir o sin publicar, dependencias cruzadas desactualizadas e instalaciones contaminadas por `npm link` o `devel-sync`. Indica además en qué orden conviene limpiarlos.

<!--lang:en--]

Reviews the local development environment after a task (or at any time) and detects the repositories left untidy: uncommitted or unpushed changes, versions not bumped or not published, outdated cross dependencies and installations contaminated by `npm link` or `devel-sync`. It also tells in which order to clean them up.

[!--lang:*-->

<!--multilang buttons-->

idioma: ![castellano](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-es.png)
también disponible en:
[![inglés](https://raw.githubusercontent.com/codenautas/multilang/master/img/lang-en.png)](README.md)

<!--lang:es-->

## Repositorios revisados

Las carpetas raíz se indican con `--path` (se puede repetir). Cada subcarpeta de una carpeta raíz que tenga `package.json` es un repositorio a revisar, salvo las que se llamen como alguno de los valores de `--ignore` (también se puede repetir).

## Valores por omisión

El archivo opcional `~/.bussing.yaml` define valores por omisión para los parámetros; las claves son los nombres de los parámetros (`bussing --help`). Lo que se indique en la línea de comandos tiene prioridad. Las carpetas relativas son relativas a la carpeta actual, igual que en la línea de comandos.

```yaml
path:
  - /path/to/repos
  - /path/to/other-repos
ignore:
  - old-repo
```

## Controles

### 1. git

* Hay cambios sin commitear (incluye archivos no versionados que no estén ignorados).
* Hay commits sin pushear.
* La rama actual no tiene upstream.

### 2. Publicación

Se compara el `package.json` local con el registro de npm:

* **Versión sin publicar:** la versión local es mayor que la última publicada.
* **Versión sin subir:** la versión local es igual a la publicada, pero el `HEAD` local es distinto del `gitHead` que npm registró al publicar esa versión (hay commits posteriores a la publicación).
* **No publicado:** el paquete no existe en npm.

Los paquetes con `"private": true` no se controlan.

### 3. Dependencias cruzadas

Si el repositorio **A** depende del repositorio **B** (ambos revisados) y en el `package.json` de A, B figura con una versión menor que la versión local de B, A tiene la dependencia desactualizada. Se revisan `dependencies`, `devDependencies`, `optionalDependencies` y `peerDependencies`; la versión declarada es la mínima del rango (`^1.2.0` es menor que `1.3.0` aunque el rango la admita).

Si un nombre de paquete está en más de un repositorio revisado, se informa y ese nombre no se usa para las dependencias cruzadas ni para el orden.

### 4. Instalación contaminada

Para cada dependencia en `node_modules`:

* **`npm link`:** `node_modules/<paquete>` es un enlace simbólico.
* **Copia (`devel-sync` u otra):** el contenido de `node_modules/<paquete>` no coincide con el paquete publicado de la versión registrada en `package-lock.json`. Solo se controlan los paquetes que son repositorios revisados (los únicos que se copian durante el desarrollo). Se tiene en cuenta que, al instalar, npm cambia CRLF por LF en el shebang de los ejecutables declarados en `bin`.

### 5. Orden de limpieza

Con los repositorios desprolijos y los que dependen de ellos (aunque estén limpios) se arma un orden topológico: primero los que no dependen de ningún otro repositorio de la lista. Para cada repositorio se indica por qué está en la lista (sus propios problemas, o qué dependencia lo obliga a actualizarse).

Para el orden se usan `dependencies`, `optionalDependencies` y `peerDependencies`, no las `devDependencies`: entre los paquetes propios forman ciclos (por ejemplo, qa-control es devDependency de librerías de las que él mismo depende). Si aun así hay un ciclo, sus integrantes quedan en el mismo paso y se indica con quiénes forman el ciclo.

## Uso

### Línea de comandos

```sh
bussing --path /path/to/repos --path /path/to/other-repos
bussing --json
```

Muestra un informe legible; con `--json` muestra el informe completo en JSON. Los parámetros y los códigos de salida se describen en `bussing --help`.

### Como librería

`bussing` puede incluirse desde otro sistema. `reviewEnvironment` recibe opciones tipadas y devuelve el informe tipado; no escribe en la salida ni termina el proceso.

```ts
import { reviewEnvironment } from 'bussing';

const report = await reviewEnvironment({ roots: ['/path/to/repos'] });
```

<!--lang:en--]

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

[!--lang:*-->

## License

[MIT](LICENSE)
