// Controles por repositorio: git, publicación, dependencias cruzadas e instalación.

import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { guarantee, is } from 'guarantee-type';
import semver from 'semver';
import * as git from './git.js';
import { declaredDependencies, readPackageJson, type PackageJson } from './repos.js';
import type { CopyDifference, Problem, Registry, Warning } from './types.js';

export interface CheckResult {
    problems: Problem[];
    warnings: Warning[];
}

function emptyResult(): CheckResult {
    return { problems: [], warnings: [] };
}

function isNotFound(err: unknown): boolean {
    return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
    }
}

// ---------------------------------------------------------------- git

export interface GitCheckResult extends CheckResult {
    /** `null` si la carpeta no es un repositorio git. */
    state: git.GitState | null;
}

export async function checkGit(dir: string): Promise<GitCheckResult> {
    if (!await exists(join(dir, '.git'))) {
        return { state: null, problems: [], warnings: [{ check: 'git', message: 'no es un repositorio git' }] };
    }
    const state = await git.getState(dir);
    const result: GitCheckResult = { state, problems: [], warnings: [] };
    if (state.changed.length > 0) result.problems.push({ kind: 'uncommitted', files: state.changed });
    if (state.branch === null) {
        result.warnings.push({ check: 'git', message: 'HEAD desacoplado (no está en ninguna rama)' });
    } else if (state.upstream === null) {
        result.problems.push({ kind: 'no-upstream', branch: state.branch });
    }
    if (state.ahead > 0) result.problems.push({ kind: 'unpushed', commits: state.ahead });
    return result;
}

// ---------------------------------------------------------------- publicación

export async function checkPublication(dir: string, pkg: PackageJson, state: git.GitState | null, registry: Registry): Promise<CheckResult> {
    const result = emptyResult();
    if (pkg.private === true) return result;
    if (pkg.name === undefined || pkg.version === undefined) {
        result.warnings.push({ check: 'publication', message: 'el package.json no tiene name o version' });
        return result;
    }
    const packument = await registry.getPackument(pkg.name);
    if (packument === null) {
        result.problems.push({ kind: 'not-published', version: pkg.version });
        return result;
    }
    const published = packument.versions[pkg.version];
    if (published === undefined) {
        result.problems.push({ kind: 'unpublished-version', version: pkg.version, latest: packument.distTags['latest'] ?? null });
        return result;
    }
    const gitHead = published.gitHead;
    if (gitHead === undefined) {
        result.warnings.push({ check: 'publication', message: `npm no registró el commit (gitHead) de la versión ${pkg.version}; no se puede saber si hay cambios posteriores` });
    } else if (state === null || state.head === null) {
        result.warnings.push({ check: 'publication', message: 'no hay commit local para comparar con el publicado' });
    } else if (gitHead !== state.head) {
        if (!await git.commitExists(dir, gitHead)) {
            result.warnings.push({ check: 'publication', message: `el commit publicado (${gitHead}) no está en el repositorio local` });
        } else if (await git.isAncestor(dir, gitHead, state.head)) {
            result.problems.push({ kind: 'version-not-bumped', version: pkg.version, commitsAfterPublish: await git.countCommits(dir, gitHead, state.head) });
        } else {
            result.warnings.push({ check: 'publication', message: `el HEAD local no desciende del commit publicado (${gitHead})` });
        }
    }
    return result;
}

// ---------------------------------------------------------------- dependencias cruzadas

/** Versión local de cada paquete revisado (solo los nombres que corresponden a un único repositorio). */
export type LocalVersions = Map<string, string>;

export function checkCrossDependencies(pkg: PackageJson, localVersions: LocalVersions): CheckResult {
    const result = emptyResult();
    for (const dep of declaredDependencies(pkg)) {
        const local = localVersions.get(dep.name);
        if (local === undefined || dep.name === pkg.name) continue;
        const minimum = semver.validRange(dep.spec) === null ? null : semver.minVersion(dep.spec);
        if (minimum === null) {
            result.warnings.push({ check: 'cross-dependencies', message: `${dep.name}: la versión declarada "${dep.spec}" (${dep.field}) no es un rango semver` });
        } else if (semver.valid(local) === null) {
            result.warnings.push({ check: 'cross-dependencies', message: `${dep.name}: la versión local "${local}" no es semver` });
        } else if (semver.lt(minimum, local)) {
            result.problems.push({ kind: 'outdated-dependency', dependency: dep.name, field: dep.field, declared: dep.spec, local });
        }
    }
    return result;
}

// ---------------------------------------------------------------- instalación

const lockDescription = is.object({
    lockfileVersion: is.number,
    packages: is.optional.recordString.object({
        version: is.optional.string,
        resolved: is.optional.string,
        integrity: is.optional.string,
        link: is.optional.boolean,
    }),
});

/** Nombres de los paquetes instalados en `node_modules` (incluye los que tienen scope). */
async function installedNames(nodeModules: string): Promise<string[]> {
    const names: string[] = [];
    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('@') && entry.isDirectory()) {
            for (const scoped of await readdir(join(nodeModules, entry.name))) names.push(`${entry.name}/${scoped}`);
        } else {
            names.push(entry.name);
        }
    }
    return names;
}

/** Rutas relativas (con `/`) de los archivos de un paquete instalado, sin su `node_modules` interno. */
async function installedFiles(root: string, relative = ''): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
            if (path !== 'node_modules') files.push(...await installedFiles(root, path));
        } else {
            files.push(path);
        }
    }
    return files;
}

const binDescription = is.object({
    bin: { optional: is.union([is.string, is.recordString.string]) },
});

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/** Archivos declarados en `bin` del package.json publicado. */
export function binFiles(tarball: Map<string, Uint8Array>): Set<string> {
    const packageJson = tarball.get('package.json');
    if (packageJson === undefined) return new Set();
    const bin = guarantee(binDescription, JSON.parse(Buffer.from(packageJson).toString('utf8'))).bin;
    const paths = bin === undefined ? [] : typeof bin === 'string' ? [bin] : Object.values(bin);
    return new Set(paths.map(normalizePath));
}

/**
 * Al instalar, npm (bin-links) cambia el fin de línea CRLF de la primera línea (el shebang) de los ejecutables por LF.
 * Devuelve el contenido publicado con ese mismo cambio aplicado.
 */
export function installedBinContent(content: Uint8Array): Uint8Array {
    const buffer = Buffer.from(content);
    const firstLineEnd = buffer.indexOf(0x0a);
    if (buffer.subarray(0, 2).toString('latin1') === '#!' && firstLineEnd > 0 && buffer[firstLineEnd - 1] === 0x0d) {
        return Buffer.concat([buffer.subarray(0, firstLineEnd - 1), buffer.subarray(firstLineEnd)]);
    }
    return content;
}

export async function compareWithTarball(installedDir: string, tarball: Map<string, Uint8Array>): Promise<CopyDifference[]> {
    const differences: CopyDifference[] = [];
    const installed = new Set(await installedFiles(installedDir));
    const bins = binFiles(tarball);
    for (const [path, published] of tarball) {
        const expected = bins.has(path) ? installedBinContent(published) : published;
        if (!installed.has(path)) {
            differences.push({ path, kind: 'missing' });
        } else if (Buffer.compare(await readFile(join(installedDir, path)), expected) !== 0) {
            differences.push({ path, kind: 'modified' });
        }
    }
    for (const path of installed) {
        if (!tarball.has(path)) differences.push({ path, kind: 'extra' });
    }
    return differences.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
}

/**
 * Busca en `node_modules` enlaces simbólicos (todas las dependencias) y copias que no coinciden con lo publicado
 * (solo las dependencias que son repositorios revisados, `localNames`).
 */
export async function checkInstallation(dir: string, localNames: Set<string>, registry: Registry): Promise<CheckResult> {
    const result = emptyResult();
    const nodeModules = join(dir, 'node_modules');
    if (!await exists(nodeModules)) return result;
    const toCompare: string[] = [];
    for (const name of await installedNames(nodeModules)) {
        const path = join(nodeModules, name);
        if ((await lstat(path)).isSymbolicLink()) {
            result.problems.push({ kind: 'linked-dependency', dependency: name, target: await readlink(path) });
        } else if (localNames.has(name) && (await stat(path)).isDirectory()) {
            toCompare.push(name);
        }
    }
    if (toCompare.length === 0) return result;
    let lockText: string;
    try {
        lockText = await readFile(join(dir, 'package-lock.json'), 'utf8');
    } catch (err) {
        if (!isNotFound(err)) throw err;
        result.warnings.push({ check: 'installation', message: `no hay package-lock.json; no se puede verificar ${toCompare.join(', ')}` });
        return result;
    }
    const lock = guarantee(lockDescription, JSON.parse(lockText));
    if (lock.packages === undefined) {
        result.warnings.push({ check: 'installation', message: `package-lock.json versión ${lock.lockfileVersion} sin "packages"; no se puede verificar ${toCompare.join(', ')}` });
        return result;
    }
    for (const name of toCompare) {
        const entry = lock.packages[`node_modules/${name}`];
        if (entry === undefined || entry.version === undefined) {
            result.warnings.push({ check: 'installation', message: `${name} no figura en package-lock.json` });
            continue;
        }
        let tarballUrl = entry.resolved;
        if (tarballUrl === undefined) {
            const packument = await registry.getPackument(name);
            tarballUrl = packument?.versions[entry.version]?.tarball;
        }
        if (tarballUrl === undefined || !/^https?:\/\//.test(tarballUrl)) {
            result.warnings.push({ check: 'installation', message: `${name}@${entry.version}: no se encontró el tarball publicado (${tarballUrl ?? 'sin resolved'})` });
            continue;
        }
        const installedDir = join(nodeModules, name);
        const differences = await compareWithTarball(installedDir, await registry.getTarballFiles(tarballUrl, entry.integrity));
        if (differences.length > 0) {
            let installedVersion: string | null;
            try {
                installedVersion = (await readPackageJson(installedDir)).version ?? null;
            } catch (err) {
                installedVersion = null;
                result.warnings.push({ check: 'installation', message: `no se pudo leer node_modules/${name}/package.json: ${err instanceof Error ? err.message : String(err)}` });
            }
            result.problems.push({ kind: 'copied-dependency', dependency: name, version: entry.version, installedVersion, differences });
        }
    }
    return result;
}
