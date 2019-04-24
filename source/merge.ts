import {URL, URLSearchParams} from 'url';
import is from '@sindresorhus/is';
import {Options, Method, NextFunction, Instance, InterfaceWithDefaults} from './utils/types';
import knownHookEvents, {Hooks, HookType, HookEvent} from './known-hook-events';

export default function merge<Target extends {[key: string]: unknown}, Source extends {[key: string]: unknown}>(target: Target, ...sources: Source[]): Target & Source {
	for (const source of sources) {
		for (const [key, sourceValue] of Object.entries(source)) {
			if (is.undefined(sourceValue)) {
				continue;
			}

			const targetValue = target[key];
			if (targetValue instanceof URLSearchParams && sourceValue instanceof URLSearchParams) {
				const params = new URLSearchParams();

				const append = (value: string, key: string) => params.append(key, value);
				targetValue.forEach(append);
				sourceValue.forEach(append);

				target[key] = params;
			} else if (is.urlInstance(targetValue) && (is.urlInstance(sourceValue) || is.string(sourceValue))) {
				target[key] = new URL(sourceValue as string, targetValue);
			} else if (is.plainObject(sourceValue)) {
				if (is.plainObject(targetValue)) {
					target[key] = merge({}, targetValue, sourceValue);
				} else {
					target[key] = merge({}, sourceValue);
				}
			} else if (is.array(sourceValue)) {
				target[key] = merge([], sourceValue);
			} else {
				target[key] = sourceValue;
			}
		}
	}

	return target as Target & Source;
}

export function mergeOptions(...sources: Partial<Options>[]): Partial<Options> & {hooks: Partial<Hooks>} {
	sources = sources.map(source => source || {});
	const merged = merge({}, ...sources);

	// TODO: This is a funky situation. Even though we "know" that we're going to
	//       populate the `hooks` object in the loop below, TypeScript want us to
	//       put them into the object upon initialization, because it cannot infer
	//       that they are going to conform correctly in runtime.
	const hooks = {} as {[Key in HookEvent]: HookType[]};
	for (const hook of knownHookEvents) {
		hooks[hook] = [];
	}

	for (const source of sources) {
		if (source.hooks) {
			for (const hook of knownHookEvents) {
				hooks[hook] = hooks[hook].concat(source.hooks[hook] || []);
			}
		}
	}

	merged.hooks = hooks as Hooks;

	return merged as Partial<Options> & {hooks: Partial<Hooks>};
}

export function mergeInstances(instances: InterfaceWithDefaults[], methods?: Method[]): Instance {
	const handlers = instances.map(instance => instance.defaults.handler);
	const size = instances.length - 1;

	return {
		methods,
		options: mergeOptions(...instances.map(instance => instance.defaults.options)),
		handler: (options: Options, next: NextFunction) => {
			let iteration = -1;
			const iterate = (options: Options): void => handlers[++iteration](options, iteration === size ? next : iterate);

			return iterate(options);
		}
	};
}
