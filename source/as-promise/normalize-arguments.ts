import is, {assert} from '@sindresorhus/is';
import {
	Options,
	NormalizedOptions,
	Defaults,
	Method
} from './types';

const normalizeArguments = (options: NormalizedOptions, defaults?: Defaults): NormalizedOptions => {
	if (is.null_(options.encoding)) {
		throw new TypeError('To get a Buffer, set `options.responseType` to `buffer` instead');
	}

	assert.any([is.string, is.undefined], options.encoding);
	assert.any([is.boolean, is.undefined], options.resolveBodyOnly);
	assert.any([is.boolean, is.undefined], options.methodRewriting);
	assert.any([is.boolean, is.undefined], options.isStream);
	assert.any([is.string, is.undefined], options.responseType);

	// `options.responseType`
	if (options.responseType === undefined) {
		options.responseType = 'text';
	}

	// `options.retry`
	const {retry} = options;

	if (defaults) {
		options.retry = {...defaults.retry};
	} else {
		options.retry = {
			calculateDelay: retryObject => retryObject.computedValue,
			limit: 0,
			methods: [],
			statusCodes: [],
			errorCodes: [],
			maxRetryAfter: undefined
		};
	}

	if (is.object(retry)) {
		options.retry = {
			...options.retry,
			...retry
		};

		options.retry.methods = [...new Set(options.retry.methods.map(method => method.toUpperCase() as Method))];
		options.retry.statusCodes = [...new Set(options.retry.statusCodes)];
		options.retry.errorCodes = [...new Set(options.retry.errorCodes)];
	} else if (is.number(retry)) {
		options.retry.limit = retry;
	}

	if (is.undefined(options.retry.maxRetryAfter)) {
		options.retry.maxRetryAfter = Math.min(
			// TypeScript is not smart enough to handle `.filter(x => is.number(x))`.
			// eslint-disable-next-line unicorn/no-fn-reference-in-iterator
			...[options.timeout.request, options.timeout.connect].filter(is.number)
		);
	}

	// `options.pagination`
	if (is.object(options.pagination)) {
		if (defaults) {
			(options as Options).pagination = {
				...defaults.pagination,
				...options.pagination
			};
		}

		const {pagination} = options;

		if (!is.function_(pagination.transform)) {
			throw new Error('`options.pagination.transform` must be implemented');
		}

		if (!is.function_(pagination.shouldContinue)) {
			throw new Error('`options.pagination.shouldContinue` must be implemented');
		}

		if (!is.function_(pagination.filter)) {
			throw new TypeError('`options.pagination.filter` must be implemented');
		}

		if (!is.function_(pagination.paginate)) {
			throw new Error('`options.pagination.paginate` must be implemented');
		}
	}

	// JSON mode
	if (options.responseType === 'json' && options.headers.accept === undefined) {
		options.headers.accept = 'application/json';
	}

	return options;
};

export default normalizeArguments;
