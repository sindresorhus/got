'use strict';
const errors = require('./errors');
const assignOptions = require('./assign-options');
const normalizeArguments = require('./normalize-arguments');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');

const handler = (url, options, isStream) => {
	const normalizedArgs = normalizeArguments(url, options);

	if (isStream || normalizedArgs.stream) {
		return asStream(normalizedArgs);
	}

	return asPromise(normalizedArgs);
};

const defaultMethods = [
	'get',
	'post',
	'put',
	'patch',
	'head',
	'delete'
];

const create = (defaults = {}, methods = defaultMethods, handle = handler) => {
	function got(url, options) {
		try {
			options = assignOptions(defaults, options);
			return handle(url, options);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.create = (options = {}, newMethods = [], newHandle = handle) => create(assignOptions(defaults, options), methods.concat(newMethods), newHandle);
	got.create.normalizeArguments = normalizeArguments;
	got.create.asStream = asStream;
	got.create.asPromise = asPromise;

	got.stream = (url, options) => {
		options = assignOptions(defaults, options);
		return handle(url, options, true);
	};

	for (const method of methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	Object.assign(got, errors);

	return got;
};

module.exports = create;
