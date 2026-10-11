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
        assert.equal(mainCategory([outdated], nobody), 'outdated-dependencies');
        assert.equal(mainCategory([outdated], function (name) { return name === 'b'; }), 'waiting-dependencies');
        assert.equal(mainCategory([outdated, { kind: 'unpushed', commits: 1 }], function () { return true; }), 'unpushed');
    });
});
