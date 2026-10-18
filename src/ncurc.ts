// Configuración de npm-check-updates (`ncu`) que bussing respeta: qué dependencias no se actualizan y hasta qué versión.
// Se lee la misma configuración que usa ncu para que la decisión quede escrita en un solo lugar.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guarantee, is } from 'guarantee-type';
import { load } from 'js-yaml';
import picomatch from 'picomatch';
import semver from 'semver';
import type { PackageVersions } from './types.js';

/** Hasta dónde se considera que hay que actualizar (opción `target` de ncu; sin la variante de función). */
export type NcuTarget = 'latest' | 'newest' | 'greatest' | 'minor' | 'patch' | 'semver' | `@${string}`;

const FIXED_TARGETS: readonly NcuTarget[] = ['latest', 'newest', 'greatest', 'minor', 'patch', 'semver'];

export interface NcuConfig {
    /** Paquetes que no se actualizan (`reject`). */
    reject: ((name: string) => boolean) | null;
    /** Si está, solo se actualizan estos paquetes (`filter`). */
    filter: ((name: string) => boolean) | null;
    target: NcuTarget;
}

export interface NcuConfigResult {
    config: NcuConfig;
    warnings: string[];
}

/** Archivos que ncu lee, en el orden en que se buscan. Los `.js`, `.mjs` y `.cjs` contienen código y no se interpretan. */
const DATA_FILES = ['.ncurc', '.ncurc.json', '.ncurc.yaml', '.ncurc.yml'];
const CODE_FILES = ['.ncurc.js', '.ncurc.mjs', '.ncurc.cjs'];

const ncurcDescription = is.object({
    reject: { optional: is.union([is.string, is.array.string]) },
    filter: { optional: is.union([is.string, is.array.string]) },
    target: is.optional.string,
});

type NcurcValues = { reject?: string | string[]; filter?: string | string[]; target?: string };

/**
 * Convierte el valor de `reject` o `filter` en una función. Como en ncu, acepta nombres, comodines y globs, listas separadas por
 * comas o espacios, y expresiones regulares entre barras (`/^react-/`).
 */
export function packageMatcher(value: string | string[]): (name: string) => boolean {
    const patterns = (typeof value === 'string' ? [value] : value).flatMap(function (item): string[] {
        return /^\/.*\/[a-z]*$/.test(item) ? [item] : item.split(/[,\s]+/).filter(function (part) { return part !== ''; });
    });
    const tests = patterns.map(function (pattern): (name: string) => boolean {
        const regex = /^\/(.*)\/([a-z]*)$/.exec(pattern);
        if (regex !== null) {
            const compiled = new RegExp(regex[1] ?? '', regex[2] ?? '');
            return function (name) { return compiled.test(name); };
        }
        return picomatch(pattern);
    });
    return function (name) { return tests.some(function (test) { return test(name); }); };
}

function isNotFound(err: unknown): boolean {
    return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/** Lee el primer archivo de configuración de ncu en `dir`; `null` si no hay ninguno. */
async function readDirConfig(dir: string, warnings: string[]): Promise<NcurcValues | null> {
    for (const file of CODE_FILES) {
        try {
            await readFile(join(dir, file));
            warnings.push(`${join(dir, file)} contiene código y no se interpreta`);
        } catch (err) {
            if (!isNotFound(err)) throw err;
        }
    }
    for (const file of DATA_FILES) {
        const path = join(dir, file);
        let text: string;
        try {
            text = await readFile(path, 'utf8');
        } catch (err) {
            if (isNotFound(err)) continue;
            throw err;
        }
        try {
            const values = guarantee(ncurcDescription, text.trim() === '' ? {} : load(text));
            const result: NcurcValues = {};
            if (values.reject !== undefined) result.reject = values.reject;
            if (values.filter !== undefined) result.filter = values.filter;
            if (values.target !== undefined) result.target = values.target;
            return result;
        } catch (err) {
            warnings.push(`${path} no se pudo interpretar (${err instanceof Error ? err.message : String(err)})`);
            return null;
        }
    }
    return null;
}

/**
 * Configuración de ncu para un repositorio: la de su carpeta y, para lo que ella no define, la de la carpeta del usuario.
 */
export async function readNcuConfig(repoDir: string, userDir: string): Promise<NcuConfigResult> {
    const warnings: string[] = [];
    const user = await readDirConfig(userDir, warnings);
    const project = await readDirConfig(repoDir, warnings);
    const values: NcurcValues = { ...user, ...project };
    let target: NcuTarget = 'latest';
    if (values.target !== undefined) {
        const fixed = FIXED_TARGETS.find(function (candidate) { return candidate === values.target; });
        if (fixed !== undefined) {
            target = fixed;
        } else if (values.target.startsWith('@')) {
            target = `@${values.target.slice(1)}`;
        } else {
            warnings.push(`target "${values.target}" de ncu no se reconoce; se usa latest`);
        }
    }
    return {
        config: {
            reject: values.reject === undefined ? null : packageMatcher(values.reject),
            filter: values.filter === undefined ? null : packageMatcher(values.filter),
            target,
        },
        warnings,
    };
}

/** Si la dependencia se controla según `reject` y `filter`. */
export function isChecked(config: NcuConfig, name: string): boolean {
    if (config.reject !== null && config.reject(name)) return false;
    return config.filter === null || config.filter(name);
}

/** Si una versión (por ejemplo la local) está dentro de lo que `target` permite, partiendo del rango declarado. */
export function allowedByTarget(target: NcuTarget, version: string, declaredMinimum: string, range: string): boolean {
    switch (target) {
        case 'minor':
            return semver.major(version) === semver.major(declaredMinimum);
        case 'patch':
            return semver.major(version) === semver.major(declaredMinimum) && semver.minor(version) === semver.minor(declaredMinimum);
        case 'semver':
            return semver.satisfies(version, range);
        default:
            return true;
    }
}

/**
 * Versión publicada a la que habría que actualizar según `target`; `null` si no hay ninguna.
 * `time` (fechas de publicación) solo hace falta para `newest`.
 */
export function targetVersion(target: NcuTarget, published: PackageVersions, declaredMinimum: string, range: string, time: Record<string, string> | null): string | null {
    const stable = published.versions.filter(function (version) { return semver.valid(version) !== null && semver.prerelease(version) === null; });
    const allowed = function (candidates: string[]): string | null {
        return semver.maxSatisfying(candidates.filter(function (version) { return allowedByTarget(target, version, declaredMinimum, range); }), '*', { includePrerelease: true });
    };
    switch (target) {
        case 'latest':
            return published.distTags['latest'] ?? null;
        case 'greatest':
            return semver.maxSatisfying(published.versions.filter(function (version) { return semver.valid(version) !== null; }), '*', { includePrerelease: true });
        case 'newest': {
            let newest: string | null = null;
            for (const version of published.versions) {
                const date = time?.[version];
                if (date !== undefined && (newest === null || date > (time?.[newest] ?? ''))) newest = version;
            }
            return newest;
        }
        case 'minor':
        case 'patch':
        case 'semver':
            return allowed(stable);
        default:
            return published.distTags[target.slice(1)] ?? null;
    }
}
