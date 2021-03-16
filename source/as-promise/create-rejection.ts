import {RequestError} from '../core/errors';
import type {CancelableRequest} from './types';
import type {BeforeErrorHook} from '../core/options';

export default function createRejection(error: Error, ...beforeErrorGroups: Array<BeforeErrorHook[] | undefined>): CancelableRequest<never> {
	const promise = (async () => {
		if (error instanceof RequestError) {
			try {
				for (const hooks of beforeErrorGroups) {
					if (hooks) {
						for (const hook of hooks) {
							// eslint-disable-next-line no-await-in-loop
							error = await hook(error as RequestError);
						}
					}
				}
			} catch (error_) {
				error = error_;
			}
		}

		throw error;
	})() as CancelableRequest<never>;

	const returnPromise = (): CancelableRequest<never> => promise;

	promise.json = returnPromise;
	promise.text = returnPromise;
	promise.buffer = returnPromise;
	promise.on = returnPromise;

	return promise;
}
