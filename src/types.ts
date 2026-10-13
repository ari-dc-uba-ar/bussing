// Tipos públicos de bussing: opciones, informe y problemas detectados.

/** Función que recibe los mensajes de progreso del core (el core nunca escribe en la salida). */
export type LogFunction = (message: string) => void;

/** Paquete tal como figura en el registro de npm (solo lo que bussing usa). */
export interface Packument {
    name: string;
    distTags: Record<string, string>;
    versions: Record<string, PublishedVersion>;
}

export interface PublishedVersion {
    version: string;
    /** Commit desde el que se publicó la versión; npm lo registra al publicar desde un repositorio git. */
    gitHead: string | undefined;
    tarball: string;
    integrity: string | undefined;
}

/** Acceso al registro de npm. Se puede reemplazar (por ejemplo en los tests). */
export interface Registry {
    /** Devuelve `null` si el paquete no existe en el registro. */
    getPackument(name: string): Promise<Packument | null>;
    /** Devuelve los archivos regulares del tarball, con la ruta relativa a la raíz del paquete. */
    getTarballFiles(tarballUrl: string, integrity: string | undefined): Promise<Map<string, Uint8Array>>;
}

export interface BussingOptions {
    /** Carpetas raíz; cada subcarpeta directa con `package.json` es un repositorio a revisar. */
    roots: string[];
    /** Nombres de subcarpetas que no se revisan. */
    ignore?: string[];
    /**
     * Categoría menos grave que interesa (ver `PROBLEM_CATEGORIES`); los problemas de categorías menos graves no se informan
     * ni se usan para el orden. Por omisión `DEFAULT_UP_TO` ("falta publicar", sin las devDependencies).
     */
    upTo?: ProblemCategory;
    /**
     * Prioridad de cada paquete como dependencia débil (devDependency) al romper ciclos; por omisión 0.
     * Las dependencias de mayor prioridad se respetan antes en el orden; las de menor prioridad son las primeras en postergarse.
     */
    dependencyPriority?: Record<string, number>;
    /** Por omisión, el registro público de npm. */
    registry?: Registry;
    log?: LogFunction;
}

export type DependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';

export type CopyDifferenceKind = 'modified' | 'missing' | 'extra';

export interface CopyDifference {
    path: string;
    kind: CopyDifferenceKind;
}

export type Problem =
    | { kind: 'uncommitted'; files: string[] }
    | { kind: 'unpushed'; commits: number }
    | { kind: 'no-upstream'; branch: string }
    | { kind: 'not-published'; version: string }
    | { kind: 'unpublished-version'; version: string; latest: string | null }
    | { kind: 'version-not-bumped'; version: string; commitsAfterPublish: number }
    | { kind: 'outdated-dependency'; dependency: string; field: DependencyField; declared: string; local: string }
    | { kind: 'linked-dependency'; dependency: string; target: string }
    | {
        kind: 'copied-dependency';
        dependency: string;
        /** Versión registrada en package-lock.json, contra cuyo tarball se compara. */
        version: string;
        /** Versión del package.json instalado (`null` si no se pudo leer). */
        installedVersion: string | null;
        differences: CopyDifference[];
    };

export type ProblemKind = Problem['kind'];

/** Categorías de problemas, de la más grave a la menos grave (ver `PROBLEM_CATEGORIES` y `PROBLEM_CATEGORY`). */
export type ProblemCategory =
    | 'uncommitted'
    | 'unpushed'
    | 'altered-node-modules'
    /** Tiene dependencias desactualizadas y alguna de ellas, con problemas propios, va antes en el orden (`waiting-*`). */
    | 'waiting-dependencies'
    | 'outdated-dependencies'
    | 'waiting-peer-dependencies'
    | 'outdated-peer-dependencies'
    | 'waiting-optional-dependencies'
    | 'outdated-optional-dependencies'
    | 'waiting-dev-dependencies'
    | 'outdated-dev-dependencies'
    | 'version-not-bumped'
    | 'unpublished';

export type CheckName = 'repo' | 'git' | 'publication' | 'cross-dependencies' | 'installation' | 'order';

/** Situación que impidió completar un control o que conviene revisar, pero que no es un problema en sí. */
export interface Warning {
    check: CheckName;
    message: string;
}

export interface RepoReport {
    /** Carpeta del repositorio. */
    dir: string;
    /** Nombre del paquete (`null` si el `package.json` no se pudo leer o no tiene nombre). */
    name: string | null;
    version: string | null;
    problems: Problem[];
    warnings: Warning[];
}

export interface CleanupStep {
    name: string;
    dir: string;
    /** Los pasos del mismo nivel no dependen entre sí. Se empieza por el nivel 0. */
    level: number;
    /** Categoría del problema propio más grave; `null` si está en la lista solo por sus dependencias. */
    mainProblem: ProblemCategory | null;
    /**
     * Si está en la lista solo por sus dependencias (`mainProblem` es `null`): el campo más grave por el que depende de un
     * repositorio con problemas que llegan a quien lo usa. `null` si tiene problemas propios.
     */
    dependencyField: DependencyField | null;
    /** Repositorios de la lista de limpieza de los que depende. */
    dependsOn: string[];
    /** Repositorios con los que forma un ciclo de dependencias fuertes (vacío si no hay ciclo). */
    inCycleWith: string[];
    /** Dependencias débiles que no se respetan en el orden porque cerrarían un ciclo: se actualizan después. */
    deferred: string[];
}

export interface BussingReport {
    repos: RepoReport[];
    /** Carpetas de repositorios que no se revisaron por estar en `ignore`. */
    ignored: string[];
    cleanupOrder: CleanupStep[];
    warnings: Warning[];
}
