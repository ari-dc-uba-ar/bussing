// Descubrimiento de repositorios y lectura de su package.json.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { guarantee, is, type GuaranteedType } from 'guarantee-type';
import type { DependencyField } from './types.js';

export const DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Campos que se usan para el orden de limpieza. Las devDependencies no se usan: entre los paquetes propios forman
 * ciclos (por ejemplo, qa-control es devDependency de las librerías de las que él mismo depende).
 */
export const ORDER_DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'optionalDependencies', 'peerDependencies'];

const packageJsonDescription = is.object({
    name: is.optional.string,
    version: is.optional.string,
    private: is.optional.boolean,
    dependencies: is.optional.recordString.string,
    devDependencies: is.optional.recordString.string,
    optionalDependencies: is.optional.recordString.string,
    peerDependencies: is.optional.recordString.string,
});

export type PackageJson = GuaranteedType<typeof packageJsonDescription>;

/** Interpreta el contenido de un package.json. Lanza un error si no es JSON o no tiene la forma esperada. */
export function parsePackageJson(text: string): PackageJson {
    return guarantee(packageJsonDescription, JSON.parse(text));
}

export async function readPackageJson(dir: string): Promise<PackageJson> {
    return parsePackageJson(await readFile(join(dir, 'package.json'), 'utf8'));
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
        throw err;
    }
}

export interface FoundRepos {
    repos: string[];
    /** Repositorios que se encontraron pero no se revisan por estar en `ignore`. */
    ignored: string[];
}

/**
 * Subcarpetas directas de cada raíz que tienen `package.json`, separando las que se llaman como algún elemento de `ignore`.
 * Lanza un error si una raíz no existe o no es una carpeta.
 */
export async function findRepos(roots: string[], ignore: string[] = []): Promise<FoundRepos> {
    if (roots.length === 0) throw new Error('No se indicó ninguna carpeta para revisar');
    const ignoreSet = new Set(ignore);
    const repos: string[] = [];
    const ignored: string[] = [];
    for (const root of roots) {
        let rootIsDir: boolean;
        try {
            rootIsDir = (await stat(root)).isDirectory();
        } catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'ENOENT') throw new Error(`La carpeta ${root} no existe`);
            throw err;
        }
        if (!rootIsDir) throw new Error(`${root} no es una carpeta`);
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
            const dir = join(root, entry.name);
            // stat (no lstat) para incluir también carpetas alcanzadas por enlaces simbólicos o junctions
            const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(dir)).isDirectory());
            if (isDir && await isFile(join(dir, 'package.json'))) (ignoreSet.has(entry.name) ? ignored : repos).push(dir);
        }
    }
    return { repos: repos.sort(), ignored: ignored.sort() };
}

/** Dependencias declaradas en los campos indicados (por omisión, todos), con el campo en que figuran. */
export function declaredDependencies(pkg: PackageJson, fields: readonly DependencyField[] = DEPENDENCY_FIELDS): { name: string; spec: string; field: DependencyField }[] {
    const result: { name: string; spec: string; field: DependencyField }[] = [];
    for (const field of fields) {
        const deps = pkg[field];
        if (deps !== undefined) {
            for (const [name, spec] of Object.entries(deps)) result.push({ name, spec, field });
        }
    }
    return result;
}
