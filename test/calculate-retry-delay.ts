import test from 'ava';
import calculateRetryDelay from '../source/core/calculate-retry-delay.js';
import type {RetryOptions} from '../source/core/options.js';

const makeError = (overrides: Record<string, unknown> = {}) => ({
	name: 'RequestError',
	code: 'ECONNRESET',
	options: {method: 'GET'},
	response: null,
	...overrides,
});

const defaultRetryOptions: RetryOptions = {
	limit: 10,
	methods: ['GET'],
	statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 504],
	errorCodes: [
		'ETIMEDOUT',
		'ECONNRESET',
		'EADDRINUSE',
		'ECONNREFUSED',
		'EPIPE',
		'ENOTFOUND',
		'ENETUNREACH',
		'EAI_AGAIN',
	],
	calculateDelay: () => 0,
	backoffLimit: Number.POSITIVE_INFINITY,
	noise: 100,
	maxRetryAfter: undefined,
	enforceRetryRules: true,
};

test('returns 0 when attemptCount exceeds limit', t => {
	const delay = calculateRetryDelay({
		attemptCount: 11,
		retryOptions: defaultRetryOptions,
		error: makeError() as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	t.is(delay, 0);
});

test('returns 1 for RetryError regardless of other conditions', t => {
	const delay = calculateRetryDelay({
		attemptCount: 1,
		retryOptions: {...defaultRetryOptions, limit: 0},
		error: makeError({name: 'RetryError'}) as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	t.is(delay, 1);
});

test('returns 0 when method is not allowed', t => {
	const delay = calculateRetryDelay({
		attemptCount: 1,
		retryOptions: {...defaultRetryOptions, methods: ['POST']},
		error: makeError() as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	t.is(delay, 0);
});

test('returns 0 when neither error code nor status code matches', t => {
	const delay = calculateRetryDelay({
		attemptCount: 1,
		retryOptions: {...defaultRetryOptions, errorCodes: [], statusCodes: []},
		error: makeError() as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	t.is(delay, 0);
});

test('respects retryAfter header value', t => {
	const delay = calculateRetryDelay({
		attemptCount: 1,
		retryOptions: defaultRetryOptions,
		error: makeError({response: {statusCode: 429}}) as any,
		retryAfter: 2000,
		computedValue: 5000,
	});
	t.is(delay, 2000);
});

test('returns 0 when retryAfter exceeds computedValue', t => {
	const delay = calculateRetryDelay({
		attemptCount: 1,
		retryOptions: defaultRetryOptions,
		error: makeError({response: {statusCode: 429}}) as any,
		retryAfter: 6000,
		computedValue: 5000,
	});
	t.is(delay, 0);
});

test('returns 0 for status 413 without retryAfter', t => {
	const delay = calculateRetryDelay({
		attemptCount: 1,
		retryOptions: {...defaultRetryOptions, statusCodes: [413]},
		error: makeError({response: {statusCode: 413}}) as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	t.is(delay, 0);
});

test('delay never exceeds backoffLimit (noise included)', t => {
	// BackoffLimit is documented as "the upper limit of the computedValue" where
	// computedValue = ((2 ** (attemptCount - 1)) * 1000) + noise.
	// The total (base + noise) must not exceed backoffLimit.
	const backoffLimit = 500;
	const noise = 100;

	for (let i = 0; i < 1000; i++) {
		const delay = calculateRetryDelay({
			attemptCount: 5, // Base = min(2^4*1000=16000, 500) = 500; total with noise can reach 600
			retryOptions: {...defaultRetryOptions, backoffLimit, noise},
			error: makeError() as any,
			retryAfter: undefined,
			computedValue: Infinity,
		});
		t.true(
			delay <= backoffLimit,
			`Delay ${delay.toFixed(2)} exceeded backoffLimit ${backoffLimit}`,
		);
	}
});

test('exponential backoff grows with attempt count', t => {
	// Noise=0 for deterministic test
	const retryOptions = {...defaultRetryOptions, noise: 0};

	const delay1 = calculateRetryDelay({
		attemptCount: 1,
		retryOptions,
		error: makeError() as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	const delay2 = calculateRetryDelay({
		attemptCount: 2,
		retryOptions,
		error: makeError() as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});
	const delay3 = calculateRetryDelay({
		attemptCount: 3,
		retryOptions,
		error: makeError() as any,
		retryAfter: undefined,
		computedValue: Infinity,
	});

	t.is(delay1, 1000); // 2^0 * 1000
	t.is(delay2, 2000); // 2^1 * 1000
	t.is(delay3, 4000); // 2^2 * 1000
});
