'use strict';
import {URL} from 'url';
import errors from './errors';
import asStream from './as-stream';
import asPromise from './as-promise';
import { normalize, preNormalize } from './normalize-arguments';
import merge, { mergeOptions, mergeInstances} from './merge';
import deepFreeze from './utils/deep-freeze';
import { InterfaceWithDefaults, Method, Options, NextFunction } from './utils/types';

const getPromiseOrStream = ( options : any ) => options.stream ? asStream(options) : asPromise(options);

const aliases : Method[]  = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

const create = (defaults : any) => {
	defaults = merge({}, defaults);
	preNormalize(defaults.options);

	if (!defaults.handler) {
		// This can't be getPromiseOrStream, because when merging
		// the chain would stop at this point and no further handlers would be called.
		defaults.handler = (options: any, next: NextFunction) => next(options);
	}

	function got(url: URL, options: Options) {
		try {
			return defaults.handler(normalize(url, options, defaults), getPromiseOrStream);
		} catch (error) {
			if (options && options.stream) {
				throw error;
			} else {
				return Promise.reject(error);
			}
		}
	}

	got.create = create;
	got.extend = (options: any) => {
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

	got.mergeInstances = ((instances: InterfaceWithDefaults[], methods: Method[]) => create(mergeInstances(instances, methods)));

	got.stream = (url: URL, options: Options) => got(url, {...options, stream: true});
	

	for (const method of aliases) {
		got[method] =  (url: URL , options: Options) => got(url, {...options, method});
		got.stream[method]= (url :URL, options : Options) => got.stream(url, {...options, method});
	}

	Object.assign(got, {...errors, mergeOptions});
	Object.defineProperty(got, 'defaults', {
		value: defaults.mutableDefaults ? defaults : deepFreeze(defaults),
		writable: defaults.mutableDefaults,
		configurable: defaults.mutableDefaults,
		enumerable: true
	});

	return got;
};

module.exports = create;
