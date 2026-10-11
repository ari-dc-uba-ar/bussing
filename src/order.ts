// Orden de limpieza: repositorios con problemas y los que dependen de ellos, en orden topológico.
// Entran los repositorios con problemas propios y, por sus dependencias fuertes (dependencies, optionalDependencies,
// peerDependencies), los que dependen de un repositorio con problemas que llegan a quien lo usa. Las dependencias fuertes se
// respetan siempre en el orden; las débiles (devDependencies) solo ordenan, y se descartan si cierran un ciclo.

import { fieldGravity } from './categories.js';
import type { CleanupStep, DependencyField, ProblemCategory } from './types.js';
import { defined, mustGet } from './util.js';

export interface OrderNode {
    /** Identifica al nodo (la carpeta del repositorio, porque dos repositorios pueden tener el mismo nombre). */
    dir: string;
    name: string;
    /** Categoría del problema propio más grave; `null` si no tiene problemas propios. */
    mainProblem: ProblemCategory | null;
    /** Si tiene algún problema que llega a quien usa el paquete (ver `REACHES_DEPENDENTS`). */
    reachesDependents: boolean;
    /** Repositorios revisados de los que depende (dependencias fuertes: siempre se respetan en el orden), con el campo más grave. */
    dependsOn: { dir: string; field: DependencyField }[];
    /** Carpetas de los repositorios revisados de los que depende como devDependency (débiles: se respetan salvo que cierren un ciclo). */
    weakDependsOn: string[];
}

function byName(a: { name: string; dir: string }, b: { name: string; dir: string }): number {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
}

/** Componentes fuertemente conexas (Tarjan), para tratar cada ciclo de dependencias como un solo paso. */
function stronglyConnectedComponents(dirs: string[], edges: Map<string, string[]>): Map<string, number> {
    const component = new Map<string, number>();
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let counter = 0;
    let components = 0;
    function visit(dir: string): void {
        index.set(dir, counter);
        low.set(dir, counter);
        counter++;
        stack.push(dir);
        onStack.add(dir);
        for (const next of edges.get(dir) ?? []) {
            if (!index.has(next)) {
                visit(next);
                low.set(dir, Math.min(mustGet(low, dir), mustGet(low, next)));
            } else if (onStack.has(next)) {
                low.set(dir, Math.min(mustGet(low, dir), mustGet(index, next)));
            }
        }
        if (low.get(dir) === index.get(dir)) {
            let member: string;
            do {
                member = defined(stack.pop(), 'elemento de la pila');
                onStack.delete(member);
                component.set(member, components);
            } while (member !== dir);
            components++;
        }
    }
    for (const dir of dirs) if (!index.has(dir)) visit(dir);
    return component;
}

/** `true` si desde `from` se llega a `to` siguiendo las aristas. */
function reaches(edges: Map<number, Set<number>>, from: number, to: number): boolean {
    const visited = new Set<number>();
    const pending = [from];
    while (pending.length > 0) {
        const current = defined(pending.pop(), 'pendiente');
        if (current === to) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(edges.get(current) ?? []));
    }
    return false;
}

/** `priority`: prioridad de cada paquete como dependencia débil (por omisión 0); ver `BussingOptions.dependencyPriority`. */
export function computeCleanupOrder(nodes: OrderNode[], priority: ReadonlyMap<string, number> = new Map()): CleanupStep[] {
    const byDir = new Map(nodes.map(function (node) { return [node.dir, node] as const; }));
    const dependents = new Map<string, string[]>();
    for (const node of nodes) {
        for (const dep of node.dependsOn) dependents.set(dep.dir, [...(dependents.get(dep.dir) ?? []), node.dir]);
    }
    // Los repositorios con problemas propios y, transitivamente por las dependencias fuertes, los que dependen de ellos
    // Entran los que tienen problemas propios; los que dependen (transitivamente) de uno cuyos problemas llegan a quien lo usa
    // entran también y, a su vez, hacen entrar a los que dependen de ellos
    const included = new Set(nodes.filter(function (node) { return node.mainProblem !== null; }).map(function (node) { return node.dir; }));
    const reaching = new Set<string>();
    const pending = nodes.filter(function (node) { return node.reachesDependents; }).map(function (node) { return node.dir; });
    while (pending.length > 0) {
        const dir = defined(pending.pop(), 'pendiente');
        if (reaching.has(dir)) continue;
        reaching.add(dir);
        included.add(dir);
        pending.push(...(dependents.get(dir) ?? []));
    }
    const dirs = [...included].sort();
    const strongEdges = new Map(dirs.map(function (dir) {
        return [dir, mustGet(byDir, dir).dependsOn.map(function (dep) { return dep.dir; }).filter(function (dep) { return included.has(dep); })] as const;
    }));
    // Los ciclos de dependencias fuertes forman un solo paso
    const component = stronglyConnectedComponents(dirs, strongEdges);
    const componentEdges = new Map<number, Set<number>>();
    function addComponentEdge(from: number, to: number): void {
        const set = componentEdges.get(from) ?? new Set<number>();
        set.add(to);
        componentEdges.set(from, set);
    }
    for (const dir of dirs) {
        for (const dep of mustGet(strongEdges, dir)) {
            if (mustGet(component, dep) !== mustGet(component, dir)) addComponentEdge(mustGet(component, dir), mustGet(component, dep));
        }
    }
    // Las dependencias débiles se respetan salvo que cierren un ciclo. Se agregan primero las de mayor prioridad (según la
    // dependencia) y, a igual prioridad, por nombre, para que el resultado sea reproducible. Las que cerrarían un ciclo se postergan.
    const acceptedWeak = new Map<string, string[]>(dirs.map(function (dir) { return [dir, []] as const; }));
    const deferredWeak = new Map<string, string[]>(dirs.map(function (dir) { return [dir, []] as const; }));
    const priorityOf = function (dir: string): number { return priority.get(mustGet(byDir, dir).name) ?? 0; };
    const weakEdges: [string, string][] = [];
    for (const dir of dirs) {
        for (const dep of mustGet(byDir, dir).weakDependsOn) if (included.has(dep)) weakEdges.push([dir, dep]);
    }
    weakEdges.sort(function ([dirA, depA], [dirB, depB]) {
        return priorityOf(depB) - priorityOf(depA) || byName(mustGet(byDir, dirA), mustGet(byDir, dirB)) || byName(mustGet(byDir, depA), mustGet(byDir, depB));
    });
    for (const [dir, dep] of weakEdges) {
        const from = mustGet(component, dir);
        const to = mustGet(component, dep);
        if (from === to) continue;
        if (reaches(componentEdges, to, from)) {
            mustGet(deferredWeak, dir).push(dep);
        } else {
            addComponentEdge(from, to);
            mustGet(acceptedWeak, dir).push(dep);
        }
    }
    // Nivel de cada componente: 0 si no depende de otra componente; si no, uno más que la de mayor nivel de la que depende
    const levels = new Map<number, number>();
    function levelOf(id: number): number {
        const known = levels.get(id);
        if (known !== undefined) return known;
        let level = 0;
        for (const dep of componentEdges.get(id) ?? []) level = Math.max(level, levelOf(dep) + 1);
        levels.set(id, level);
        return level;
    }
    const steps: CleanupStep[] = dirs.map(function (dir) {
        const node = mustGet(byDir, dir);
        const id = mustGet(component, dir);
        const names = function (list: string[]): string[] { return list.map(function (d) { return mustGet(byDir, d).name; }).sort(); };
        const deps = [...mustGet(strongEdges, dir).filter(function (dep) { return mustGet(component, dep) !== id; }), ...mustGet(acceptedWeak, dir)];
        return {
            name: node.name,
            dir,
            level: levelOf(id),
            mainProblem: node.mainProblem,
            dependencyField: node.mainProblem !== null ? null : node.dependsOn
                .filter(function (dep) { return reaching.has(dep.dir); })
                .map(function (dep) { return dep.field; })
                .sort(function (a, b) { return fieldGravity(a) - fieldGravity(b); })[0] ?? null,
            dependsOn: names([...new Set(deps)]),
            deferred: names(mustGet(deferredWeak, dir)),
            inCycleWith: names(dirs.filter(function (other) { return other !== dir && mustGet(component, other) === id; })),
        };
    });
    return steps.sort(function (a, b) { return a.level - b.level || byName(a, b); });
}
