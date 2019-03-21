import * as errors from './errors';
import asStream from './as-stream';
import asPromise from './as-promise';
import {normalizeArguments, preNormalizeArguments} from './normalize-arguments';
import merge, {mergeOptions, mergeInstances} from './merge';
import deepFreeze from './utils/deep-freeze';

const getPromiseOrStream = options => options.stream ? asStream(options) : asPromise(options);

const aliases = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

const create = defaults => {
	defaults = merge({}, defaults);
	preNormalizeArguments(defaults.options);

	if (!defaults.handler) {
		// This can't be getPromiseOrStream, because when merging
		// the chain would stop at this point and no further handlers would be called.
		defaults.handler = (options, next) => next(options);
	}

	function got(url, options?: any) {
		try {
			return defaults.handler(normalizeArguments(url, options, defaults), getPromiseOrStream);
		} catch (error) {
			if (options && options.stream) {
				throw error;
			} else {
				return Promise.reject(error);
			}
		}
	}

	got.create = create;
	got.extend = options => {
		let mutableDefaults;
		if (options && Reflect.has(options, 'mutableDefaults')) {
			mutableDefaults = options.mutableDefaults;
			delete options.mutableDefaults;
		} else {
			mutableDefaults = defaults.mutableDefaults;
		}

		return create({
			options: mergeOptions(defaults.options, options),
			handler: defaults.handler,
			mutableDefaults
		});
	};

	got.mergeInstances = (...args) => create(mergeInstances(args));

	got.stream = (url, options?: any) => got(url, {...options, stream: true});

	for (const method of aliases) {
		got[method] = (url, options?: any) => got(url, {...options, method});
		got.stream[method] = (url, options?: any) => got.stream(url, {...options, method});
	}

	Object.assign(got, {...errors, mergeOptions});
	Object.defineProperty(got, 'defaults', {
		value: defaults.mutableDefaults ? defaults : deepFreeze(defaults),
		writable: defaults.mutableDefaults,
		configurable: defaults.mutableDefaults,
		enumerable: true
	});

	return got as any;
};

export default create;
