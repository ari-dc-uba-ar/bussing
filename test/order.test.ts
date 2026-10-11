import { strict as assert } from 'node:assert';
import { computeCleanupOrder, type OrderNode } from '../src/order.js';

function node(name: string, ownProblems: boolean, dependsOn: string[] = [], weakDependsOn: string[] = []): OrderNode {
    const dirs = function (list: string[]): string[] { return list.map(function (dep) { return `/r/${dep}`; }); };
    return {
        dir: `/r/${name}`,
        name,
        mainProblem: ownProblems ? 'uncommitted' : null,
        reachesDependents: ownProblems,
        dependsOn: dirs(dependsOn).map(function (dir) { return { dir, field: 'dependencies' as const }; }),
        weakDependsOn: dirs(weakDependsOn),
    };
}

describe('computeCleanupOrder', function () {
    it('incluye los dependientes (transitivos) de los repositorios con problemas y los ordena por nivel', function () {
        const steps = computeCleanupOrder([
            node('base', true),
            node('medio', false, ['base']),
            node('arriba', false, ['medio', 'otro']),
            node('otro', true),
            node('limpio', false, ['ajeno']),
            node('ajeno', false),
        ]);
        assert.deepEqual(steps.map(function (step) { return [step.level, step.name, step.mainProblem !== null, step.dependsOn]; }), [
            [0, 'base', true, []],
            [0, 'otro', true, []],
            [1, 'medio', false, ['base']],
            [2, 'arriba', false, ['medio', 'otro']],
        ]);
    });
    it('agrupa los ciclos en un mismo nivel', function () {
        const steps = computeCleanupOrder([
            node('a', true, ['b']),
            node('b', false, ['a', 'c']),
            node('c', true),
            node('d', false, ['a']),
        ]);
        assert.deepEqual(steps.map(function (step) { return [step.level, step.name, step.dependsOn, step.inCycleWith]; }), [
            [0, 'c', [], []],
            [1, 'a', [], ['b']],
            [1, 'b', ['c'], ['a']],
            [2, 'd', ['a'], []],
        ]);
    });
    it('respeta las dependencias débiles salvo que cierren un ciclo', function () {
        const steps = computeCleanupOrder([
            node('lib', true, [], ['qa']),
            node('qa', true, ['util'], ['lib']),
            node('util', true, [], ['qa']),
            node('app', true, [], ['qa']),
            node('limpio', false, [], ['qa']),
        ]);
        // lib -> qa se acepta (es la primera por nombre); qa -> lib cerraría un ciclo; util -> qa también (qa depende fuerte de util)
        assert.deepEqual(steps.map(function (step) { return [step.level, step.name, step.dependsOn, step.deferred]; }), [
            [0, 'util', [], ['qa']],
            [1, 'qa', ['util'], ['lib']],
            [2, 'app', ['qa'], []],
            [2, 'lib', ['qa'], []],
        ]);
    });
    it('las prioridades deciden qué dependencia débil se posterga en un ciclo', function () {
        // el ciclo de require-bro, qa-control y best-globals
        const nodes = [
            node('require-bro', true, [], ['qa-control']),
            node('qa-control', true, ['best-globals']),
            node('best-globals', true, [], ['require-bro']),
        ];
        const describe = function (steps: ReturnType<typeof computeCleanupOrder>): (string | number | string[])[][] {
            return steps.map(function (step) { return [step.level, step.name, step.dependsOn, step.deferred]; });
        };
        // sin prioridades se agrega primero best-globals -> require-bro (por nombre)
        assert.deepEqual(describe(computeCleanupOrder(nodes)), [
            [0, 'require-bro', [], ['qa-control']],
            [1, 'best-globals', ['require-bro'], []],
            [2, 'qa-control', ['best-globals'], []],
        ]);
        const priority = new Map([['qa-control', 1], ['require-bro', -1]]);
        assert.deepEqual(describe(computeCleanupOrder(nodes, priority)), [
            [0, 'best-globals', [], ['require-bro']],
            [1, 'qa-control', ['best-globals'], []],
            [2, 'require-bro', ['qa-control'], []],
        ]);
    });
    it('solo entran por dependencia los que dependen de un repositorio cuyos problemas llegan a quien lo usa', function () {
        const soloDev: OrderNode = { ...node('solo-dev', true), mainProblem: 'outdated-dev-dependencies', reachesDependents: false };
        const steps = computeCleanupOrder([
            soloDev,
            node('base', true),
            { ...node('usa-solo-dev', false), dependsOn: [{ dir: '/r/solo-dev', field: 'dependencies' }] },
            { ...node('usa-base', false), dependsOn: [{ dir: '/r/base', field: 'optionalDependencies' }, { dir: '/r/solo-dev', field: 'dependencies' }] },
            { ...node('usa-usa-base', false), dependsOn: [{ dir: '/r/usa-base', field: 'peerDependencies' }] },
        ]);
        assert.deepEqual(steps.map(function (step) { return [step.level, step.name, step.mainProblem, step.dependencyField]; }), [
            [0, 'base', 'uncommitted', null],
            [0, 'solo-dev', 'outdated-dev-dependencies', null],
            [1, 'usa-base', null, 'optionalDependencies'],
            [2, 'usa-usa-base', null, 'peerDependencies'],
        ]);
    });
});
