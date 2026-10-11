import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { countCommits, getState, isAncestor, commitExists, parseStatus } from '../dist/git.js';
import { addRemote, git, gitRepo, tempDir } from './helpers.js';

describe('git', function () {
    describe('parseStatus', function () {
        it('interpreta rama, upstream, ahead/behind y archivos cambiados', function () {
            const output = [
                '# branch.oid 1234567890123456789012345678901234567890',
                '# branch.head main',
                '# branch.upstream origin/main',
                '# branch.ab +2 -1',
                '1 .M N... 100644 100644 100644 aaa bbb src/con espacio.ts',
                '2 R. N... 100644 100644 100644 aaa bbb R100 nuevo.ts',
                'viejo.ts',
                'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicto.ts',
                '? sin-versionar.txt',
                '',
            ].join('\0');
            assert.deepEqual(parseStatus(output), {
                branch: 'main',
                head: '1234567890123456789012345678901234567890',
                upstream: 'origin/main',
                ahead: 2,
                behind: 1,
                changed: ['src/con espacio.ts', 'nuevo.ts', 'conflicto.ts', 'sin-versionar.txt'],
            });
        });
        it('HEAD desacoplado y repositorio sin commits', function () {
            assert.deepEqual(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0'), {
                branch: null, head: null, upstream: null, ahead: 0, behind: 0, changed: [],
            });
        });
        it('rechaza líneas desconocidas', function () {
            assert.throws(function () { parseStatus('X algo raro\0'); }, /no reconocida/);
            assert.throws(function () { parseStatus('# branch.ab +x -y\0'); }, /no reconocida/);
        });
    });
    describe('con un repositorio real', function () {
        it('detecta commits sin pushear y archivos sin commitear', async function () {
            const base = await tempDir();
            const dir = join(base, 'repo');
            const first = await gitRepo(dir, { 'a.txt': 'a\n' });
            addRemote(dir, join(base, 'remote.git'));
            await writeFile(join(dir, 'b.txt'), 'b\n');
            git(dir, 'add', '.');
            git(dir, 'commit', '-q', '-m', 'segundo');
            await writeFile(join(dir, 'c.txt'), 'c\n');
            const state = await getState(dir);
            assert.equal(state.branch, 'main');
            assert.equal(state.upstream, 'origin/main');
            assert.equal(state.ahead, 1);
            assert.deepEqual(state.changed, ['c.txt']);
            const head = git(dir, 'rev-parse', 'HEAD');
            assert.equal(await isAncestor(dir, first, head), true);
            assert.equal(await isAncestor(dir, head, first), false);
            assert.equal(await countCommits(dir, first, head), 1);
            assert.equal(await commitExists(dir, first), true);
            assert.equal(await commitExists(dir, '0123456789012345678901234567890123456789'), false);
            await assert.rejects(isAncestor(dir, 'no-existe', head), /merge-base/);
            await assert.rejects(countCommits(dir, 'no-existe', head), /rev-list/);
        });
    });
});
