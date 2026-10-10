import { strict as assert } from 'node:assert';
import { mainProblem } from '../src/categories.js';

describe('mainProblem', function () {
    it('elige la categoría más grave', function () {
        assert.equal(mainProblem([]), null);
        assert.equal(mainProblem([
            { kind: 'not-published', version: '1.0.0' },
            { kind: 'outdated-dependency', dependency: 'b', field: 'dependencies', declared: '^1.0.0', local: '1.1.0' },
            { kind: 'no-upstream', branch: 'main' },
        ]), 'unpushed');
        assert.equal(mainProblem([{ kind: 'version-not-bumped', version: '1.0.0', commitsAfterPublish: 1 }, { kind: 'linked-dependency', dependency: 'b', target: '../b' }]), 'altered-node-modules');
    });
});
