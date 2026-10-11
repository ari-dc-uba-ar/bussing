import { strict as assert } from 'node:assert';
import { mainCategory } from '../src/categories.js';
import type { Problem } from '../src/types.js';

describe('mainCategory', function () {
    const nobody = function (): boolean { return false; };
    const outdated: Problem = { kind: 'outdated-dependency', dependency: 'b', field: 'devDependencies', declared: '^1.0.0', local: '1.1.0' };
    it('elige la categoría más grave', function () {
        assert.equal(mainCategory([], nobody), null);
        assert.equal(mainCategory([{ kind: 'not-published', version: '1.0.0' }, outdated, { kind: 'no-upstream', branch: 'main' }], nobody), 'unpushed');
        assert.equal(mainCategory([{ kind: 'version-not-bumped', version: '1.0.0', commitsAfterPublish: 1 }, { kind: 'linked-dependency', dependency: 'b', target: '../b' }], nobody), 'altered-node-modules');
    });
    it('espera dependencias si alguna dependencia desactualizada tiene problemas propios', function () {
        assert.equal(mainCategory([outdated], nobody), 'outdated-dev-dependencies');
        assert.equal(mainCategory([outdated], function (name) { return name === 'b'; }), 'waiting-dev-dependencies');
        assert.equal(mainCategory([outdated, { kind: 'unpushed', commits: 1 }], function () { return true; }), 'unpushed');
    });
    it('el campo de la dependencia pesa más que tener que esperarla', function () {
        const productiva: Problem = { kind: 'outdated-dependency', dependency: 'c', field: 'dependencies', declared: '^1.0.0', local: '1.1.0' };
        const peer: Problem = { kind: 'outdated-dependency', dependency: 'd', field: 'peerDependencies', declared: '^1.0.0', local: '1.1.0' };
        const opcional: Problem = { kind: 'outdated-dependency', dependency: 'e', field: 'optionalDependencies', declared: '^1.0.0', local: '1.1.0' };
        const todos = function (): boolean { return true; };
        assert.equal(mainCategory([outdated, productiva], todos), 'waiting-dependencies');
        assert.equal(mainCategory([outdated, productiva], function (name) { return name === 'b'; }), 'outdated-dependencies');
        assert.equal(mainCategory([outdated, peer], function (name) { return name === 'b'; }), 'outdated-peer-dependencies');
        assert.equal(mainCategory([outdated, opcional], todos), 'waiting-optional-dependencies');
        assert.equal(mainCategory([opcional, { kind: 'version-not-bumped', version: '1.0.0', commitsAfterPublish: 1 }], nobody), 'outdated-optional-dependencies');
    });
});
