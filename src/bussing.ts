// bussing: revisa el ambiente local de repositorios y arma el orden de limpieza.
// Es la librería (el core): no lee process.argv, no escribe en la salida y no termina el proceso.

import { basename } from 'node:path';
import { mainCategory } from './categories.js';
import { checkCrossDependencies, checkGit, checkInstallation, checkPublication, type CheckResult, type LocalVersions } from './checks.js';
import { computeCleanupOrder, type OrderNode } from './order.js';
import { createNpmRegistry } from './registry.js';
import { declaredDependencies, findRepos, ORDER_DEPENDENCY_FIELDS, readPackageJson, WEAK_ORDER_DEPENDENCY_FIELDS, type PackageJson } from './repos.js';
import { defined, mustGet } from './util.js';
import type { DependencyField, BussingOptions, BussingReport, CheckName, LogFunction, RepoReport, Warning } from './types.js';

export type * from './types.js';
export { createNpmRegistry, DEFAULT_REGISTRY_URL } from './registry.js';
export { DEPENDENCY_CATEGORY, mainCategory, PROBLEM_CATEGORIES, PROBLEM_CATEGORY, problemCategory } from './categories.js';

/** Cantidad de repositorios que se revisan en paralelo. */
const CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(defined(items[i], 'elemento'));
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Ejecuta un control; si falla, lo informa como advertencia del repositorio en lugar de interrumpir la revisión. */
async function runCheck(report: RepoReport, check: CheckName, fn: () => Promise<CheckResult> | CheckResult): Promise<void> {
    try {
        const result = await fn();
        report.problems.push(...result.problems);
        report.warnings.push(...result.warnings);
    } catch (err) {
        report.warnings.push({ check, message: `falló el control: ${errorMessage(err)}` });
    }
}

interface RepoData {
    report: RepoReport;
    pkg: PackageJson | null;
}

export async function reviewEnvironment(options: BussingOptions): Promise<BussingReport> {
    const registry = options.registry ?? createNpmRegistry();
    const log: LogFunction = options.log ?? function () { /* sin informe de progreso */ };
    const warnings: Warning[] = [];
    const ignore = options.ignore ?? [];
    const { repos: dirs, ignored } = await findRepos(options.roots, ignore);
    for (const name of ignore) {
        if (!ignored.some(function (dir) { return basename(dir) === name; })) {
            warnings.push({ check: 'repo', message: `ninguna carpeta de repositorio se llama ${name} (ignore)` });
        }
    }
    log(`${dirs.length} repositorios encontrados`);

    // package.json de cada repositorio
    const repos: RepoData[] = await Promise.all(dirs.map(async function (dir): Promise<RepoData> {
        const report: RepoReport = { dir, name: null, version: null, problems: [], warnings: [] };
        try {
            const pkg = await readPackageJson(dir);
            report.name = pkg.name ?? null;
            report.version = pkg.version ?? null;
            return { report, pkg };
        } catch (err) {
            report.warnings.push({ check: 'repo', message: `no se pudo leer package.json: ${errorMessage(err)}` });
            return { report, pkg: null };
        }
    }));

    // Nombres locales: los que corresponden a más de un repositorio no se usan para dependencias cruzadas ni orden
    const dirsByName = new Map<string, string[]>();
    for (const { report } of repos) {
        if (report.name !== null) dirsByName.set(report.name, [...(dirsByName.get(report.name) ?? []), report.dir]);
    }
    const uniqueDirByName = new Map<string, string>();
    const localVersions: LocalVersions = new Map();
    for (const [name, list] of dirsByName) {
        if (list.length > 1) {
            warnings.push({ check: 'cross-dependencies', message: `el paquete ${name} está en varios repositorios (${list.join(', ')}); no se usa para dependencias cruzadas ni para el orden` });
            continue;
        }
        const dir = defined(list[0], 'carpeta del repositorio');
        uniqueDirByName.set(name, dir);
        const version = repos.find(function (repo) { return repo.report.dir === dir; })?.report.version;
        if (version !== null && version !== undefined) localVersions.set(name, version);
    }
    const localNames = new Set(dirsByName.keys());

    await mapWithConcurrency(repos, CONCURRENCY, async function ({ report, pkg }) {
        log(`revisando ${report.dir}`);
        let gitState: Awaited<ReturnType<typeof checkGit>>['state'] = null;
        await runCheck(report, 'git', async function () {
            const result = await checkGit(report.dir);
            gitState = result.state;
            return result;
        });
        if (pkg === null) return;
        await runCheck(report, 'publication', function () { return checkPublication(report.dir, pkg, gitState, registry); });
        await runCheck(report, 'cross-dependencies', function () { return checkCrossDependencies(pkg, localVersions); });
        await runCheck(report, 'installation', function () { return checkInstallation(report.dir, localNames, registry); });
    });

    function localDependencies(report: RepoReport, pkg: PackageJson | null, fields: readonly DependencyField[]): string[] {
        const result = new Set<string>();
        for (const dep of pkg === null ? [] : declaredDependencies(pkg, fields)) {
            const depDir = uniqueDirByName.get(dep.name);
            if (depDir !== undefined && depDir !== report.dir) result.add(depDir);
        }
        return [...result];
    }
    const priority = new Map(Object.entries(options.dependencyPriority ?? {}));
    for (const name of priority.keys()) {
        if (!uniqueDirByName.has(name)) warnings.push({ check: 'order', message: `ningún repositorio revisado tiene el paquete ${name} (prioridad de dependencia)` });
    }
    const nodes: OrderNode[] = repos.map(function ({ report, pkg }): OrderNode {
        return {
            dir: report.dir,
            name: report.name ?? basename(report.dir),
            mainProblem: mainCategory(report.problems, function () { return false; }),
            dependsOn: localDependencies(report, pkg, ORDER_DEPENDENCY_FIELDS),
            weakDependsOn: localDependencies(report, pkg, WEAK_ORDER_DEPENDENCY_FIELDS),
        };
    });
    const cleanupOrder = computeCleanupOrder(nodes, priority);
    // "espera dependencias" solo si alguna dependencia desactualizada con problemas propios queda antes en el orden
    const hasProblems = new Set(repos.filter(function (repo) { return repo.report.problems.length > 0; }).map(function (repo) { return repo.report.name; }));
    const reportByDir = new Map(repos.map(function (repo) { return [repo.report.dir, repo.report] as const; }));
    for (const step of cleanupOrder) {
        step.mainProblem = mainCategory(mustGet(reportByDir, step.dir).problems, function (name) {
            return hasProblems.has(name) && step.dependsOn.includes(name);
        });
    }
    return { repos: repos.map(function (repo) { return repo.report; }), ignored, cleanupOrder, warnings };
}
