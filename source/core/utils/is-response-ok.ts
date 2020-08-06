import {Response} from '..';

export const isResponseOk = (response: Response): boolean => {
	const {statusCode} = response;
	const limitStatusCode = response.request.options.followRedirect ? 299 : 399;

	return (statusCode >= 200 && statusCode <= limitStatusCode) || statusCode === 304;
};
