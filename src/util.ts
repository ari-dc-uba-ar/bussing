// Utilidades internas.

/** Valor de una clave que, por construcción, tiene que estar en el Map. Lanza un error si no está. */
export function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
    const value = map.get(key);
    if (value === undefined) throw new Error(`Error interno: falta la clave ${String(key)}`);
    return value;
}

/** Elemento que, por construcción, tiene que existir. Lanza un error si es `undefined`. */
export function defined<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`Error interno: falta ${what}`);
    return value;
}
