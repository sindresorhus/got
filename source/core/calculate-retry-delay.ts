import type {RetryFunction} from './options.js';

type Returns<T extends (...arguments_: any) => unknown, V> = (...arguments_: Parameters<T>) => V;

const calculateRetryDelay: Returns<RetryFunction, number> = ({
	attemptCount,
	retryOptions,
	error,
	retryAfter,
	computedValue,
}) => {
	if (error.name === 'RetryError') {
		return 1;
	}

	if (attemptCount > retryOptions.limit) {
		return 0;
	}

	const hasMethod = retryOptions.methods.includes(error.options.method);
	const hasErrorCode = retryOptions.errorCodes.includes(error.code);
	const hasStatusCode = error.response && retryOptions.statusCodes.includes(error.response.statusCode);
	if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
		return 0;
	}

	if (error.response) {
		if (retryAfter !== undefined) {
			// In this case `computedValue` is `retryOptions.maxRetryAfter ?? options.timeout.request ?? Infinity`
			// Compare the server delay before applying the minimum nonzero retry timer.
			return retryAfter > computedValue ? 0 : Math.max(1, retryAfter);
		}

		if (error.response.statusCode === 413) {
			return 0;
		}
	}

	const noise = Math.random() * retryOptions.noise;
	// Zero disables retries, so represent an immediate retry with the minimum timer delay.
	return Math.max(1, Math.min(((2 ** (attemptCount - 1)) * 1000), retryOptions.backoffLimit) + noise);
};

export default calculateRetryDelay;
