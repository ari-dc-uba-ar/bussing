// Categorías de problemas y su gravedad.

import type { DependencyField, Problem, ProblemCategory, ProblemKind } from './types.js';

/**
 * De la más grave a la menos grave. Primero lo que puede hacer perder trabajo, después lo que hace fallar en otros entornos.
 * Las dependencias desactualizadas van antes de subir la versión porque al corregirlas cambia el package.json.
 * Entre ellas pesa primero el campo (productivas, peer, opcionales, dev) y, dentro de un campo, esperar va antes.
 */
export const PROBLEM_CATEGORIES: readonly ProblemCategory[] = [
    'uncommitted',
    'unpushed',
    'altered-node-modules',
    'waiting-dependencies',
    'outdated-dependencies',
    'waiting-peer-dependencies',
    'outdated-peer-dependencies',
    'waiting-optional-dependencies',
    'outdated-optional-dependencies',
    'waiting-dev-dependencies',
    'outdated-dev-dependencies',
    'version-not-bumped',
    'unpublished',
];

/** Categoría de cada tipo de problema, salvo las dependencias desactualizadas (ver `DEPENDENCY_CATEGORY`). */
export const PROBLEM_CATEGORY: Record<Exclude<ProblemKind, 'outdated-dependency'>, ProblemCategory> = {
    'uncommitted': 'uncommitted',
    'unpushed': 'unpushed',
    'no-upstream': 'unpushed',
    'linked-dependency': 'altered-node-modules',
    'copied-dependency': 'altered-node-modules',
    'version-not-bumped': 'version-not-bumped',
    'unpublished-version': 'unpublished',
    'not-published': 'unpublished',
};

/** Categoría de una dependencia desactualizada según el campo en que figura y si hay que esperarla. */
export const DEPENDENCY_CATEGORY: Record<DependencyField, { waiting: ProblemCategory; outdated: ProblemCategory }> = {
    'dependencies': { waiting: 'waiting-dependencies', outdated: 'outdated-dependencies' },
    'peerDependencies': { waiting: 'waiting-peer-dependencies', outdated: 'outdated-peer-dependencies' },
    'optionalDependencies': { waiting: 'waiting-optional-dependencies', outdated: 'outdated-optional-dependencies' },
    'devDependencies': { waiting: 'waiting-dev-dependencies', outdated: 'outdated-dev-dependencies' },
};

/**
 * Si el problema llega a quien usa el paquete (y por lo tanto los repositorios que dependen de él entran en la lista de
 * limpieza). No llegan las devDependencies desactualizadas ni node_modules alterado (es la instalación local, no el contenido).
 */
export const REACHES_DEPENDENTS: Record<ProblemCategory, boolean> = {
    'uncommitted': true,
    'unpushed': true,
    'altered-node-modules': false,
    'waiting-dependencies': true,
    'outdated-dependencies': true,
    'waiting-peer-dependencies': true,
    'outdated-peer-dependencies': true,
    'waiting-optional-dependencies': true,
    'outdated-optional-dependencies': true,
    'waiting-dev-dependencies': false,
    'outdated-dev-dependencies': false,
    'version-not-bumped': true,
    'unpublished': true,
};

/** Gravedad de un campo de dependencias (menor es más grave), según el lugar de sus categorías en `PROBLEM_CATEGORIES`. */
export function fieldGravity(field: DependencyField): number {
    return PROBLEM_CATEGORIES.indexOf(DEPENDENCY_CATEGORY[field].outdated);
}

/** Categoría de un problema. Una dependencia desactualizada es `waiting-*` si hay que esperarla (`mustWait`). */
export function problemCategory(problem: Problem, mustWait: (name: string) => boolean): ProblemCategory {
    if (problem.kind === 'outdated-dependency') {
        const categories = DEPENDENCY_CATEGORY[problem.field];
        return mustWait(problem.dependency) ? categories.waiting : categories.outdated;
    }
    return PROBLEM_CATEGORY[problem.kind];
}

/** Categoría más grave entre los problemas; `null` si no hay problemas. */
export function mainCategory(problems: Problem[], mustWait: (name: string) => boolean): ProblemCategory | null {
    let best: number | null = null;
    for (const problem of problems) {
        const index = PROBLEM_CATEGORIES.indexOf(problemCategory(problem, mustWait));
        if (best === null || index < best) best = index;
    }
    return best === null ? null : PROBLEM_CATEGORIES[best] ?? null;
}
