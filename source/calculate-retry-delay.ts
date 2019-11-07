import is from '@sindresorhus/is';
import {HTTPError, ParseError, MaxRedirectsError, GotError} from './errors';
import {RetryFunction} from './utils/types';

const retryAfterStatusCodes: ReadonlySet<number> = new Set([413, 429, 503]);

const calculateRetryDelay: RetryFunction = ({attemptCount, retryOptions, error}) => {
	if (attemptCount > retryOptions.limit) {
		return 0;
	}

	const hasMethod = retryOptions.methods.includes((error as GotError).options.method);
	const hasErrorCode = Reflect.has(error, 'code') && retryOptions.errorCodes.includes((error as GotError).code);
	const hasStatusCode = Reflect.has(error, 'response') && retryOptions.statusCodes.includes((error as HTTPError | ParseError | MaxRedirectsError).response.statusCode);
	if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
		return 0;
	}

	// TODO: This type coercion is not entirely correct as it makes `response` a guaranteed property, when it's in fact not.
	const {response} = error as HTTPError | ParseError | MaxRedirectsError;
	if (response && Reflect.has(response.headers, 'retry-after') && retryAfterStatusCodes.has(response.statusCode)) {
		let after = Number(response.headers['retry-after']);
		if (is.nan(after)) {
			after = Date.parse(response.headers['retry-after']) - Date.now();
		} else {
			after *= 1000;
		}

		if (after > retryOptions.maxRetryAfter) {
			return 0;
		}

		return after;
	}

	if (response?.statusCode === 413) {
		return 0;
	}

	const noise = Math.random() * 100;
	return ((2 ** (attemptCount - 1)) * 1000) + noise;
};

export default calculateRetryDelay;
