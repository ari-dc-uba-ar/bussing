// Consultas a git. Se invoca el ejecutable `git` sin shell.

import { execFile } from 'node:child_process';

export interface GitState {
    /** Rama actual; `null` si el HEAD está desacoplado. */
    branch: string | null;
    /** Commit actual; `null` si el repositorio todavía no tiene commits. */
    head: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    /** Archivos modificados, en conflicto o no versionados (los ignorados no se incluyen). */
    changed: string[];
}

interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

function runGit(dir: string, args: string[]): Promise<GitResult> {
    return new Promise(function (resolve, reject) {
        execFile('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, function (err, stdout, stderr) {
            if (err === null) {
                resolve({ code: 0, stdout, stderr });
            } else if (typeof err.code === 'number') {
                resolve({ code: err.code, stdout, stderr });
            } else {
                reject(err);
            }
        });
    });
}

async function git(dir: string, args: string[]): Promise<string> {
    const result = await runGit(dir, args);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} (en ${dir}) terminó con código ${result.code}: ${result.stderr.trim()}`);
    return result.stdout;
}

/** Interpreta la salida de `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string): GitState {
    const state: GitState = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, changed: [] };
    const items = output.split('\0');
    for (let i = 0; i < items.length; i++) {
        const item = items[i] ?? '';
        if (item.startsWith('# branch.oid ')) {
            const oid = item.slice('# branch.oid '.length);
            state.head = oid === '(initial)' ? null : oid;
        } else if (item.startsWith('# branch.head ')) {
            const branch = item.slice('# branch.head '.length);
            state.branch = branch === '(detached)' ? null : branch;
        } else if (item.startsWith('# branch.upstream ')) {
            state.upstream = item.slice('# branch.upstream '.length);
        } else if (item.startsWith('# branch.ab ')) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(item);
            if (match === null) throw new Error(`Línea de git status no reconocida: ${item}`);
            state.ahead = Number(match[1]);
            state.behind = Number(match[2]);
        } else if (item.startsWith('1 ')) {
            state.changed.push(item.split(' ').slice(8).join(' '));
        } else if (item.startsWith('2 ')) {
            state.changed.push(item.split(' ').slice(9).join(' '));
            i++; // el siguiente elemento es la ruta original del renombre
        } else if (item.startsWith('u ')) {
            state.changed.push(item.split(' ').slice(10).join(' '));
        } else if (item.startsWith('? ')) {
            state.changed.push(item.slice(2));
        } else if (item !== '' && !item.startsWith('# ')) {
            throw new Error(`Línea de git status no reconocida: ${item}`);
        }
    }
    return state;
}

export async function getState(dir: string): Promise<GitState> {
    return parseStatus(await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']));
}

/** `true` si el commit existe en el repositorio local. */
export async function commitExists(dir: string, commit: string): Promise<boolean> {
    const result = await runGit(dir, ['cat-file', '-e', `${commit}^{commit}`]);
    return result.code === 0;
}

/** `true` si `ancestor` es ancestro de `descendant` (o es el mismo commit). */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await runGit(dir, ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error(`git merge-base --is-ancestor (en ${dir}) terminó con código ${result.code}: ${result.stderr.trim()}`);
}

/** Cantidad de commits alcanzables desde `to` que no lo son desde `from`. */
export async function countCommits(dir: string, from: string, to: string): Promise<number> {
    return Number((await git(dir, ['rev-list', '--count', `${from}..${to}`])).trim());
}
