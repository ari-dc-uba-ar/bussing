// Orden de limpieza: repositorios con problemas y los que dependen de ellos, en orden topológico.

import type { CleanupStep, ProblemCategory } from './types.js';
import { defined, mustGet } from './util.js';

export interface OrderNode {
    /** Identifica al nodo (la carpeta del repositorio, porque dos repositorios pueden tener el mismo nombre). */
    dir: string;
    name: string;
    /** Categoría del problema propio más grave; `null` si no tiene problemas propios. */
    mainProblem: ProblemCategory | null;
    /** Carpetas de los repositorios revisados de los que depende. */
    dependsOn: string[];
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

export function computeCleanupOrder(nodes: OrderNode[]): CleanupStep[] {
    const byDir = new Map(nodes.map(function (node) { return [node.dir, node] as const; }));
    const dependents = new Map<string, string[]>();
    for (const node of nodes) {
        for (const dep of node.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), node.dir]);
    }
    // Los repositorios con problemas propios y, transitivamente, los que dependen de ellos
    const included = new Set<string>();
    const pending = nodes.filter(function (node) { return node.mainProblem !== null; }).map(function (node) { return node.dir; });
    while (pending.length > 0) {
        const dir = defined(pending.pop(), 'pendiente');
        if (included.has(dir)) continue;
        included.add(dir);
        pending.push(...(dependents.get(dir) ?? []));
    }
    const dirs = [...included].sort();
    const edges = new Map(dirs.map(function (dir) {
        return [dir, mustGet(byDir, dir).dependsOn.filter(function (dep) { return included.has(dep); })] as const;
    }));
    const component = stronglyConnectedComponents(dirs, edges);
    // Nivel de cada componente: 0 si no depende de otra componente; si no, uno más que la de mayor nivel de la que depende
    const levels = new Map<number, number>();
    function levelOf(id: number): number {
        const known = levels.get(id);
        if (known !== undefined) return known;
        let level = 0;
        for (const dir of dirs) {
            if (component.get(dir) !== id) continue;
            for (const dep of mustGet(edges, dir)) {
                const depComponent = mustGet(component, dep);
                if (depComponent !== id) level = Math.max(level, levelOf(depComponent) + 1);
            }
        }
        levels.set(id, level);
        return level;
    }
    const steps: CleanupStep[] = dirs.map(function (dir) {
        const node = mustGet(byDir, dir);
        const id = mustGet(component, dir);
        const names = function (list: string[]): string[] { return list.map(function (d) { return mustGet(byDir, d).name; }).sort(); };
        return {
            name: node.name,
            dir,
            level: levelOf(id),
            mainProblem: node.mainProblem,
            dependsOn: names(mustGet(edges, dir).filter(function (dep) { return component.get(dep) !== id; })),
            inCycleWith: names(dirs.filter(function (other) { return other !== dir && component.get(other) === id; })),
        };
    });
    return steps.sort(function (a, b) { return a.level - b.level || byName(a, b); });
}
