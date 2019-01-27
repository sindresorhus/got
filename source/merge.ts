import {URL} from 'url';
import is from '@sindresorhus/is';
// XO doesn't recognize `export type` for some reason.
// eslint-disable-next-line import/named
import knownHookEvents, {Hooks, HookType, HookEvent} from './known-hook-events';

// TODO: Use the Got options-object types.
interface Options {
	hooks?: Partial<Hooks>;
	[key: string]: unknown | Options;
}

export default function merge(target: Options, ...sources: Options[]) {
	for (const source of sources) {
		for (const [key, sourceValue] of Object.entries(source)) {
			if (is.undefined(sourceValue)) {
				continue;
			}

			const targetValue = target[key];
			if (is.urlInstance(targetValue) && (is.urlInstance(sourceValue) || is.string(sourceValue))) {
				target[key] = new URL(sourceValue as string, targetValue);
			} else if (is.plainObject(sourceValue)) {
				if (is.plainObject(targetValue)) {
					target[key] = merge({}, targetValue as Options, sourceValue as Options);
				} else {
					target[key] = merge({}, sourceValue as Options);
				}
			} else if (is.array(sourceValue)) {
				target[key] = merge([], sourceValue);
			} else {
				target[key] = sourceValue;
			}
		}
	}

	return target;
}

export function mergeOptions(...sources: Options[]) {
	sources = sources.map(source => source || {});
	const merged = merge({}, ...sources);

	// TODO: This is a funky situation. Even though we "know" that we're going to
	//       populate the `hooks` object in the loop below, TypeScript want us to //       put them into the object upon initialization, because it cannot infer
	//       that they are going to conform correctly in runtime.
	// eslint-disable-next-line @typescript-eslint/no-object-literal-type-assertion
	const hooks = {} as { [Key in HookEvent]: HookType[] };
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

	return merged;
}

type NextFunction = (error?: Error | string) => void;

type IterateFunction = (options: Options) => void;

type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'TRACE';

interface Instance {
	defaults: {
		handler: (options: Options, callback: NextFunction | IterateFunction) => void;
		options: Options;
	};
}

export function mergeInstances(instances: Instance[], methods: Method[]) {
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
