#!/usr/bin/env node
// Línea de comandos de bussing. Es el único módulo que usa cleye y process.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { cli, parseCommandLine, runMain } from 'commendatore';
import type { ExitCode } from 'commendatore';
import { guarantee, is, type Description, type GuaranteedType } from 'guarantee-type';
import { load } from 'js-yaml';
import { DEFAULT_REGISTRY_URL, DEFAULT_UP_TO, PROBLEM_CATEGORIES, createNpmRegistry, reviewEnvironment } from './bussing.js';
import type { BussingOptions, DependencyField, ProblemCategory, BussingReport, CleanupStep, Problem, RepoReport, Warning } from './bussing.js';

export const EXIT_CODE = {
    clean: 0,
    error: 1,
    problems: 2,
} as const;

const EXIT_CODES: ExitCode[] = [
    { code: EXIT_CODE.clean, description: 'sin problemas' },
    { code: EXIT_CODE.error, description: 'error' },
    { code: EXIT_CODE.problems, description: 'hay problemas' },
];

/** Archivo opcional, en la carpeta del usuario, con valores por omisión para los parámetros. */
const DEFAULTS_FILE_NAME = '.bussing.yaml';

/** Cómo se nombra el archivo de valores por omisión en los mensajes y en la ayuda. */
export const DEFAULTS_FILE_LABEL = `~/${DEFAULTS_FILE_NAME}`;

export function defaultsPath(): string {
    return join(homedir(), DEFAULTS_FILE_NAME);
}

/** Interpreta `paquete=número` (el número puede ser negativo). */
export function parsePriority(value: string): [string, number] {
    const match = /^(.+)=(-?\d+)$/.exec(value);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error(`--priority ${value} no tiene la forma paquete=número`);
    }
    return [match[1], Number(match[2])];
}

/** Categoría a la que equivale `--dev`: incluye las dos categorías de devDependencies, que son las menos graves. */
const DEV_UP_TO: ProblemCategory = 'outdated-dev-dependencies';

/** Interpreta el nombre de una categoría (las claves del informe JSON). `source` indica de dónde viene, para el mensaje de error. */
export function parseCategory(value: string, source = '--up-to'): ProblemCategory {
    const category = PROBLEM_CATEGORIES.find(function (candidate) { return candidate === value; });
    if (category === undefined) throw new Error(`${source} ${value} no es una categoría (las categorías son: ${PROBLEM_CATEGORIES.join(', ')})`);
    return category;
}

/** Parámetros de la línea de comandos. Las mismas claves se pueden usar en el archivo de valores por omisión. */
const flags = {
    path: {
        type: [String],
        alias: 'p',
        description: 'Carpeta raíz a revisar; se puede repetir (cada subcarpeta con package.json es un repositorio)',
    },
    ignore: {
        type: [String],
        description: 'Nombre de una subcarpeta que no se revisa; se puede repetir',
    },
    priority: {
        type: [parsePriority],
        description: 'Prioridad de un paquete como devDependency al romper ciclos del orden de limpieza, como paquete=número ' +
            '(por omisión 0; las de mayor número se respetan primero); se puede repetir',
    },
    'up-to': {
        type: function (value: string): ProblemCategory { return parseCategory(value); },
        description: `Categoría menos grave que se informa (por omisión ${DEFAULT_UP_TO}). De más grave a menos grave: ${PROBLEM_CATEGORIES.join(', ')}`,
    },
    dev: {
        type: Boolean,
        description: `Incluye las devDependencies (equivale a --up-to ${DEV_UP_TO})`,
    },
    registry: {
        type: String,
        description: `URL del registro de npm (por omisión ${DEFAULT_REGISTRY_URL})`,
    },
    json: {
        type: Boolean,
        description: 'Muestra el informe completo en JSON',
    },
} as const;

type FlagName = keyof typeof flags;

/** Tipo de cada clave del archivo de valores por omisión: una por parámetro (el compilador verifica que sean las mismas). */
const defaultsFields = {
    // una carpeta sola o una lista
    path: { optional: is.union([is.string, is.array.string]) },
    ignore: { optional: is.union([is.string, is.array.string]) },
    // en el archivo es un mapa paquete: número
    priority: is.optional.recordString.number,
    'up-to': is.optional.string,
    dev: is.optional.boolean,
    registry: is.optional.string,
    json: is.optional.boolean,
} satisfies Record<FlagName, Description>;

const defaultsDescription = is.object(defaultsFields);

type DefaultsFile = GuaranteedType<typeof defaultsDescription>;

/** Valores por omisión ya normalizados: `path` e `ignore` siempre son listas y `up-to` es una categoría válida. */
export type Defaults = Omit<DefaultsFile, 'path' | 'ignore' | 'up-to'> & { path?: string[]; ignore?: string[]; 'up-to'?: ProblemCategory };

export interface CliOptions {
    roots: string[];
    ignore: string[];
    upTo: ProblemCategory;
    priority: Record<string, number>;
    registry: string;
    json: boolean;
}


/**
 * Lee el archivo de valores por omisión. Si no existe o está vacío no hay valores por omisión.
 * `label` es el nombre del archivo en los mensajes de error.
 */
export function readDefaults(file: string, label: string): Defaults {
    if (!existsSync(file)) return {};
    const text = readFileSync(file, 'utf8');
    if (text.trim() === '') return {};
    let content: unknown;
    try {
        content = load(text);
    } catch (err) {
        throw new Error(`${label} no es un YAML válido (${err instanceof Error ? err.message : String(err)})`);
    }
    if (content === undefined || content === null) return {};
    if (typeof content !== 'object' || Array.isArray(content)) throw new Error(`${label} no contiene claves y valores`);
    const unknownKeys = Object.keys(content).filter(function (key) { return !(key in flags); });
    if (unknownKeys.length > 0) {
        throw new Error(`${label} tiene claves desconocidas: ${unknownKeys.join(', ')} (las claves válidas son: ${Object.keys(flags).join(', ')})`);
    }
    let values: DefaultsFile;
    try {
        values = guarantee(defaultsDescription, content);
    } catch (err) {
        throw new Error(`${label} tiene valores de tipo incorrecto (${err instanceof Error ? err.message : String(err)})`);
    }
    const { path, ignore, 'up-to': upTo, ...others } = values;
    const defaults: Defaults = others;
    if (path !== undefined) defaults.path = typeof path === 'string' ? [path] : path;
    if (ignore !== undefined) defaults.ignore = typeof ignore === 'string' ? [ignore] : ignore;
    if (upTo !== undefined) defaults['up-to'] = parseCategory(upTo, `${label} up-to`);
    if (defaults.dev !== undefined && upTo !== undefined) throw new Error(`${label} tiene dev y up-to a la vez (dev equivale a up-to ${DEV_UP_TO})`);
    return defaults;
}

/**
 * Interpreta los argumentos. cleye muestra la ayuda y termina el proceso ante `--help`, `--version` o un flag desconocido.
 * La primera línea de la salida es la versión, salvo que la salida sea JSON; `write` indica dónde se escribe (por omisión, la salida estándar).
 */
export function parseArgs(argv: string[], defaults: Defaults, write?: (text: string) => void): CliOptions {
    const { parsed } = parseCommandLine({
        moduleUrl: import.meta.url,
        description: 'Revisa los repositorios locales y muestra los que quedaron desprolijos y el orden en que conviene limpiarlos.\n' +
            `Los valores por omisión de los parámetros se pueden definir en ${DEFAULTS_FILE_LABEL} (las claves son los nombres de los parámetros).`,
        examples: ['bussing --path ../repos --path ../otros-repos --ignore repo-viejo', 'bussing --priority qa-control=1 --priority require-bro=-1', 'bussing --json'],
        exitCodes: EXIT_CODES,
    }, function (base) {
        return cli({ ...base, flags }, undefined, argv);
    }, {
        show: function (parsedArgs) { return !(parsedArgs.flags.json ?? defaults.json ?? false); },
        ...(write === undefined ? {} : { write }),
    });
    // las carpetas relativas son relativas a la carpeta actual, vengan de la línea de comandos o del archivo
    const roots = (parsed.flags.path.length > 0 ? parsed.flags.path : defaults.path ?? []).map(function (path) { return resolve(path); });
    if (roots.length === 0) {
        throw new Error(`Falta indicar la carpeta con --path o definir los parámetros predeterminados en ${DEFAULTS_FILE_LABEL}`);
    }
    const flagUpTo = parsed.flags['up-to'];
    const flagDev = parsed.flags.dev;
    if (flagUpTo !== undefined && flagDev !== undefined) throw new Error(`Se indicaron --dev y --up-to a la vez (--dev equivale a --up-to ${DEV_UP_TO})`);
    // la línea de comandos tiene prioridad sobre el archivo; --dev y dev son atajos de up-to
    const upTo = flagUpTo ?? (flagDev !== undefined ? (flagDev ? DEV_UP_TO : DEFAULT_UP_TO)
        : defaults['up-to'] ?? (defaults.dev === true ? DEV_UP_TO : DEFAULT_UP_TO));
    return {
        roots,
        ignore: parsed.flags.ignore.length > 0 ? parsed.flags.ignore : defaults.ignore ?? [],
        upTo,
        priority: parsed.flags.priority.length > 0 ? Object.fromEntries(parsed.flags.priority) : defaults.priority ?? {},
        registry: parsed.flags.registry ?? defaults.registry ?? DEFAULT_REGISTRY_URL,
        json: parsed.flags.json ?? defaults.json ?? false,
    };
}

const MAX_LISTED = 5;

function listSome(items: string[]): string {
    return items.slice(0, MAX_LISTED).join(', ') + (items.length > MAX_LISTED ? `, … (${items.length - MAX_LISTED} más)` : '');
}

function plural(count: number, singular: string, pluralForm: string): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function describeProblem(problem: Problem): string {
    switch (problem.kind) {
        case 'uncommitted':
            return `${plural(problem.files.length, 'archivo sin commitear', 'archivos sin commitear')}: ${listSome(problem.files)}`;
        case 'unpushed':
            return plural(problem.commits, 'commit sin pushear', 'commits sin pushear');
        case 'no-upstream':
            return `la rama ${problem.branch} no tiene upstream`;
        case 'not-published':
            return `el paquete no está publicado en npm (versión local ${problem.version})`;
        case 'unpublished-version':
            return `versión ${problem.version} sin publicar (en npm: ${problem.latest ?? 'sin latest'})`;
        case 'version-not-bumped':
            return `versión ${problem.version} sin subir: ${plural(problem.commitsAfterPublish, 'commit posterior', 'commits posteriores')} a la publicación`;
        case 'outdated-dependency':
            return `dependencia desactualizada: ${problem.dependency} "${problem.declared}" (${problem.field}), versión local ${problem.local}`;
        case 'linked-dependency':
            return `node_modules/${problem.dependency} es un enlace a ${problem.target}`;
        case 'copied-dependency':
            return `node_modules/${problem.dependency} no coincide con la versión publicada ${problem.version}` +
                (problem.installedVersion !== problem.version ? ` (el package.json instalado dice ${problem.installedVersion ?? '?'})` : '') + ': ' +
                listSome(problem.differences.map(function (difference) { return `${difference.path} (${difference.kind})`; }));
    }
}

function describeWarning(warning: Warning): string {
    return `advertencia (${warning.check}): ${warning.message}`;
}

function describeRepo(repo: RepoReport): string[] {
    const title = repo.name === null ? repo.dir : `${repo.name}${repo.version === null ? '' : '@' + repo.version}  ${repo.dir}`;
    return [
        title,
        ...repo.problems.map(function (problem) { return '  - ' + describeProblem(problem); }),
        ...repo.warnings.map(function (warning) { return '  ? ' + describeWarning(warning); }),
    ];
}

/** Sufijo de cada campo de dependencias en las etiquetas ("dependencias-dev desactualizadas", "por dependencia-peer"). */
const FIELD_SUFFIX: Record<DependencyField, string> = {
    'dependencies': '',
    'peerDependencies': '-peer',
    'optionalDependencies': '-opt',
    'devDependencies': '-dev',
};

export const CATEGORY_LABEL: Record<ProblemCategory, string> = {
    'uncommitted': 'falta commitear',
    'unpushed': 'falta pushear',
    'altered-node-modules': 'node_modules alterado',
    'waiting-dependencies': `espera dependencias${FIELD_SUFFIX.dependencies}`,
    'outdated-dependencies': `dependencias${FIELD_SUFFIX.dependencies} desactualizadas`,
    'waiting-peer-dependencies': `espera dependencias${FIELD_SUFFIX.peerDependencies}`,
    'outdated-peer-dependencies': `dependencias${FIELD_SUFFIX.peerDependencies} desactualizadas`,
    'waiting-optional-dependencies': `espera dependencias${FIELD_SUFFIX.optionalDependencies}`,
    'outdated-optional-dependencies': `dependencias${FIELD_SUFFIX.optionalDependencies} desactualizadas`,
    'waiting-dev-dependencies': `espera dependencias${FIELD_SUFFIX.devDependencies}`,
    'outdated-dev-dependencies': `dependencias${FIELD_SUFFIX.devDependencies} desactualizadas`,
    'version-not-bumped': 'falta subir versión',
    'unpublished': 'falta publicar',
};

function describeStep(step: CleanupStep): string {
    const details: string[] = [];
    if (step.dependsOn.length > 0) details.push('depende de ' + step.dependsOn.join(', '));
    if (step.inCycleWith.length > 0) details.push('ciclo con ' + step.inCycleWith.join(', '));
    if (step.deferred.length > 0) details.push(`ciclo: ${step.deferred.join(', ')} ${step.deferred.length === 1 ? 'se actualiza' : 'se actualizan'} después`);
    const folder = basename(step.dir);
    const label = step.mainProblem !== null ? CATEGORY_LABEL[step.mainProblem]
        : `por dependencia${step.dependencyField === null ? '' : FIELD_SUFFIX[step.dependencyField]}`;
    return `  ${step.level + 1}. ${step.name}${folder === step.name ? '' : ` [${folder}]`}  ${label}` + (details.length > 0 ? `  (${details.join('; ')})` : '');
}

export function formatReport(report: BussingReport): string {
    const withProblems = report.repos.filter(function (repo) { return repo.problems.length > 0; });
    const withWarningsOnly = report.repos.filter(function (repo) { return repo.problems.length === 0 && repo.warnings.length > 0; });
    const lines: string[] = [`${plural(withProblems.length, 'repositorio con problemas', 'repositorios con problemas')} de ${report.repos.length} revisados` +
        (report.ignored.length > 0 ? ` (${plural(report.ignored.length, 'ignorado', 'ignorados')}: ${report.ignored.map(function (dir) { return basename(dir); }).join(', ')})` : '')];
    for (const repo of [...withProblems, ...withWarningsOnly]) lines.push('', ...describeRepo(repo));
    if (report.cleanupOrder.length > 0) {
        lines.push('', 'Orden de limpieza (los del mismo número no dependen entre sí; dentro de cada número se respetan además las dependencias fuera del umbral):', ...report.cleanupOrder.map(describeStep));
    }
    if (report.warnings.length > 0) lines.push('', ...report.warnings.map(describeWarning));
    return lines.join('\n') + '\n';
}

export async function main(argv: string[]): Promise<number> {
    try {
        const options = parseArgs(argv, readDefaults(defaultsPath(), DEFAULTS_FILE_LABEL));
        const reviewOptions: BussingOptions = {
            roots: options.roots,
            ignore: options.ignore,
            upTo: options.upTo,
            dependencyPriority: options.priority,
            registry: createNpmRegistry(options.registry),
            log: function (message) { if (process.stderr.isTTY) process.stderr.write(`\r\u001b[K${message}`); },
        };
        const report = await reviewEnvironment(reviewOptions);
        if (process.stderr.isTTY) process.stderr.write('\r\u001b[K');
        process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
        return report.repos.some(function (repo) { return repo.problems.length > 0; }) ? EXIT_CODE.problems : EXIT_CODE.clean;
    } catch (err) {
        if (process.stderr.isTTY) process.stderr.write('\r\u001b[K');
        process.stderr.write(`bussing: ${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_CODE.error;
    }
}

// Solo se ejecuta al invocarlo como programa (no al importarlo desde los tests)
if (import.meta.main) {
    runMain(function () { return main(process.argv.slice(2)); }, EXIT_CODE.error);
}
