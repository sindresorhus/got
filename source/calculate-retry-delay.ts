import is from '@sindresorhus/is';
import {HTTPError, ParseError, MaxRedirectsError, GotError} from './errors';
import {
	RetryFunction,
	ErrorCode,
	StatusCode,
	Method
} from './utils/types';

const retryAfterStatusCodes: ReadonlySet<StatusCode> = new Set([413, 429, 503]);

const calculateRetryDelay: RetryFunction = (iteration, retryOptions, error) => {
	if (iteration > retryOptions.limit) {
		return 0;
	}

	const hasMethod = retryOptions.methods.has((error as GotError).options.method as Method);
	const hasErrorCode = Reflect.has(error, 'code') && retryOptions.errorCodes.has((error as GotError).code as ErrorCode);
	const hasStatusCode = Reflect.has(error, 'response') && retryOptions.statusCodes.has((error as HTTPError | ParseError | MaxRedirectsError).response.statusCode as StatusCode);
	if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
		return 0;
	}

	const {response} = error as HTTPError | ParseError | MaxRedirectsError;
	if (response && Reflect.has(response.headers, 'retry-after') && retryAfterStatusCodes.has(response.statusCode as StatusCode)) {
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

	if (response && response.statusCode === 413) {
		return 0;
	}

	const noise = Math.random() * 100;
	return ((2 ** (iteration - 1)) * 1000) + noise;
};

export default calculateRetryDelay;
