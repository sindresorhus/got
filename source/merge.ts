import is from '@sindresorhus/is';
import {Options, Method, Defaults, NormalizedOptions, CancelableRequest, Response} from './utils/types';
import knownHookEvents, {Hooks, HookEvent, HookType} from './known-hook-events';
import {Got} from './create';
import {ProxyStream} from './as-stream';

const URLGlobal: typeof URL = typeof URL === 'undefined' ? require('url').URL : URL;
const URLSearchParamsGlobal: typeof URLSearchParams = typeof URLSearchParams === 'undefined' ? require('url').URLSearchParams : URLSearchParams;

export default function merge<Target extends Record<string, unknown>, Source extends Record<string, unknown>>(target: Target, ...sources: Source[]): Target & Source {
	for (const source of sources) {
		for (const [key, sourceValue] of Object.entries(source)) {
			if (is.undefined(sourceValue)) {
				continue;
			}

			const targetValue = target[key];
			if (targetValue instanceof URLSearchParamsGlobal && sourceValue instanceof URLSearchParamsGlobal) {
				const params = new URLSearchParamsGlobal();

				const append = (value: string, key: string): void => params.append(key, value);
				targetValue.forEach(append);
				sourceValue.forEach(append);

				target[key] = params;
			} else if (is.urlInstance(targetValue) && (is.urlInstance(sourceValue) || is.string(sourceValue))) {
				target[key] = new URLGlobal(sourceValue as string, targetValue);
			} else if (is.plainObject(sourceValue)) {
				if (is.plainObject(targetValue)) {
					target[key] = merge({}, targetValue, sourceValue);
				} else {
					target[key] = merge({}, sourceValue);
				}
			} else if (is.array(sourceValue)) {
				target[key] = sourceValue.slice();
			} else {
				target[key] = sourceValue;
			}
		}
	}

	return target as Target & Source;
}

export function mergeOptions<T extends Options>(...sources: T[]): T & { hooks: Partial<Hooks> } {
	const mergedOptions = merge({} as T & { hooks: Partial<Hooks> }, ...sources.map(source => source || {}));

	const hooks = knownHookEvents.reduce((acc, current) => ({...acc, [current]: []}), {}) as Record<HookEvent, HookType[]>;

	for (const source of sources) {
		// We need to check `source` to allow calling `.extend()` with no arguments.
		if (source && source.hooks) {
			for (const hook of knownHookEvents) {
				hooks[hook] = hooks[hook].concat(source.hooks[hook] || []);
			}
		}
	}

	mergedOptions.hooks = hooks as Hooks;

	return mergedOptions;
}

export function mergeInstances(instances: Got[], methods?: Method[]): Defaults {
	const handlers = instances.map(instance => instance.defaults.handler);
	const size = instances.length - 1;

	return {
		methods,
		options: mergeOptions(...instances.map(instance => instance.defaults.options || {})),
		handler: <T extends ProxyStream | CancelableRequest<Response>>(options: NormalizedOptions, next: (options: NormalizedOptions) => T) => {
			let iteration = 0;
			const iterate = (newOptions: NormalizedOptions): T => handlers[++iteration]!(newOptions, iteration === size ? next : iterate);

			return iterate(options);
		}
	};
}
