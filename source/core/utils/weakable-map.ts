export default class WeakableMap<K, V> {
	weakMap = new WeakMap<Record<string, unknown>, V>();
	map = new Map<K, V>();

	set(key: K, value: V): void {
		if (typeof key === 'object') {
			this.weakMap.set(key as unknown as Record<string, unknown>, value);
		} else {
			this.map.set(key, value);
		}
	}

	get(key: K): V | undefined {
		return typeof key === 'object' ? this.weakMap.get(key as unknown as Record<string, unknown>) : this.map.get(key);
	}

	has(key: K): boolean {
		return typeof key === 'object' ? this.weakMap.has(key as unknown as Record<string, unknown>) : this.map.has(key);
	}
}
