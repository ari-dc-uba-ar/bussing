// Categorías de problemas y su gravedad.

import type { Problem, ProblemCategory, ProblemKind } from './types.js';

/**
 * De la más grave a la menos grave. Primero lo que puede hacer perder trabajo, después lo que hace fallar en otros entornos.
 * Las dependencias desactualizadas van antes de subir la versión porque al corregirlas cambia el package.json.
 */
export const PROBLEM_CATEGORIES: readonly ProblemCategory[] = [
    'uncommitted',
    'unpushed',
    'altered-node-modules',
    'outdated-dependencies',
    'version-not-bumped',
    'unpublished',
];

export const PROBLEM_CATEGORY: Record<ProblemKind, ProblemCategory> = {
    'uncommitted': 'uncommitted',
    'unpushed': 'unpushed',
    'no-upstream': 'unpushed',
    'linked-dependency': 'altered-node-modules',
    'copied-dependency': 'altered-node-modules',
    'outdated-dependency': 'outdated-dependencies',
    'version-not-bumped': 'version-not-bumped',
    'unpublished-version': 'unpublished',
    'not-published': 'unpublished',
};

/** Categoría más grave entre los problemas; `null` si no hay problemas. */
export function mainProblem(problems: Problem[]): ProblemCategory | null {
    for (const category of PROBLEM_CATEGORIES) {
        if (problems.some(function (problem) { return PROBLEM_CATEGORY[problem.kind] === category; })) return category;
    }
    return null;
}
