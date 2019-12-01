import is from '@sindresorhus/is';
import {HTTPError, ParseError, MaxRedirectsError} from './errors';
import {RetryFunction, RetryObject} from './utils/types';

const retryAfterStatusCodes: ReadonlySet<number> = new Set([413, 429, 503]);

const isErrorWithResponse = (error: RetryObject['error']): error is HTTPError | ParseError | MaxRedirectsError => (
	error instanceof HTTPError || error instanceof ParseError || error instanceof MaxRedirectsError
);

const calculateRetryDelay: RetryFunction = ({attemptCount, retryOptions, error}) => {
	if (attemptCount > retryOptions.limit) {
		return 0;
	}

	const hasMethod = retryOptions.methods.includes(error.options.method);
	const hasErrorCode = Reflect.has(error, 'code') && retryOptions.errorCodes.includes(error.code);
	const hasStatusCode = isErrorWithResponse(error) && retryOptions.statusCodes.includes(error.response.statusCode);
	if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
		return 0;
	}

	if (isErrorWithResponse(error)) {
		const {response} = error;
		if (response && Reflect.has(response.headers, 'retry-after') && retryAfterStatusCodes.has(response.statusCode)) {
			let after = Number(response.headers['retry-after']);
			if (is.nan(after)) {
				after = Date.parse(response.headers['retry-after']!) - Date.now();
			} else {
				after *= 1000;
			}

			if (after > retryOptions.maxRetryAfter) {
				return 0;
			}

			return after;
		}

		if (response.statusCode === 413) {
			return 0;
		}
	}

	const noise = Math.random() * 100;
	return ((2 ** (attemptCount - 1)) * 1000) + noise;
};

export default calculateRetryDelay;
