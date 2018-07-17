'use strict';
const URLGlobal = typeof URL === 'undefined' ? require('url').URL : URL; // TODO: Use the `URL` global when targeting Node.js 10
const extend = require('extend');
const errors = require('./errors');
const assignOptions = require('./assign-options');
const asStream = require('./as-stream');
const asPromise = require('./as-promise');
const normalizeArguments = require('./normalize-arguments');
const defineConstProperty = require('./define-const-property');

const makeNext = defaults => (path, options) => {
	let url = path;

	if (options.baseUrl) {
		url = new URLGlobal(path, options.baseUrl);
	}

	options = normalizeArguments(url, options, defaults);

	if (options.stream) {
		return asStream(options);
	}

	return asPromise(options);
};

const create = defaults => {
	defaults = extend(true, {}, defaults);

	const next = makeNext(defaults);
	if (!defaults.handler) {
		defaults.handler = next;
	}

	function got(url, options) {
		try {
			options = assignOptions(defaults.options, options);
			return defaults.handler(url, options, next);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	got.extend = (options = {}) => create({
		options: assignOptions(defaults.options, options),
		methods: defaults.methods,
		handler: defaults.handler
	});

	got.stream = (url, options) => {
		options = assignOptions(defaults.options, options);
		options.stream = true;
		return defaults.handler(url, options, next);
	};

	defaults.options.hooks = {
		beforeRequest: [],
		...(defaults.options.hooks || {})
	};
	got.hooks = defaults.options.hooks;

	for (const method of defaults.methods) {
		got[method] = (url, options) => got(url, {...options, method});
		got.stream[method] = (url, options) => got.stream(url, {...options, method});
	}

	defineConstProperty(got, {...errors, create}, {deepFreeze: true});
	defineConstProperty(got, {defaults}, {deepFreeze: defaults.preventChanges});

	return got;
};

module.exports = create;
