import {RetryFunction} from './index';

type Returns<T extends (...args: any) => unknown, V> = (...args: Parameters<T>) => V;

export const retryAfterStatusCodes: ReadonlySet<number> = new Set([413, 429, 503]);

const calculateRetryDelay: Returns<RetryFunction, number> = ({attemptCount, retryOptions, error, retryAfter}) => {
	if (attemptCount > retryOptions.limit) {
		return 0;
	}

	const hasMethod = retryOptions.methods.includes(error.options.method);
	const hasErrorCode = retryOptions.errorCodes.includes(error.code!);
	const hasStatusCode = error.response && retryOptions.statusCodes.includes(error.response.statusCode);
	if (!hasMethod || (!hasErrorCode && !hasStatusCode)) {
		return 0;
	}

	if (error.response) {
		if (retryAfter) {
			if (retryOptions.maxRetryAfter === undefined || retryAfter > retryOptions.maxRetryAfter) {
				return 0;
			}

			return retryAfter;
		}

		if (error.response.statusCode === 413) {
			return 0;
		}
	}

	const noise = Math.random() * 100;
	return ((2 ** (attemptCount - 1)) * 1000) + noise;
};

export default calculateRetryDelay;
