import { strict as assert } from 'node:assert';
import { computeCleanupOrder, type OrderNode } from '../src/order.js';

function node(name: string, ownProblems: boolean, dependsOn: string[] = []): OrderNode {
    return { dir: `/r/${name}`, name, mainProblem: ownProblems ? 'uncommitted' : null, dependsOn: dependsOn.map(function (dep) { return `/r/${dep}`; }) };
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
});
