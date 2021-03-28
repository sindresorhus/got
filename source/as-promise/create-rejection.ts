import type {CancelableRequest} from './types';

export default function createRejection(error: Error): CancelableRequest<never> {
	const promise = (async () => {
		throw error;
	})() as CancelableRequest<never>;

	const returnPromise = (): CancelableRequest<never> => promise;

	promise.json = returnPromise;
	promise.text = returnPromise;
	promise.buffer = returnPromise;
	promise.on = returnPromise;

	return promise;
}
