import {ReadStream, stat} from 'fs';
import {promisify} from 'util';
import {ClientRequestArgs} from 'http';
import is from '@sindresorhus/is';
import isFormData from './is-form-data';

interface Options {
	body?: unknown;
	headers: ClientRequestArgs['headers'];
}

const statAsync = promisify(stat);

export default async (options: Options): Promise<number | undefined> => {
	const {body, headers} = options;

	if (headers && 'content-length' in headers) {
		return Number(headers['content-length']);
	}

	if (!body) {
		return 0;
	}

	if (is.string(body)) {
		return Buffer.byteLength(body);
	}

	if (is.buffer(body)) {
		return body.length;
	}

	if (isFormData(body)) {
		return promisify(body.getLength.bind(body))();
	}

	if (body instanceof ReadStream) {
		const {size} = await statAsync(body.path);
		return size;
	}

	return undefined;
};
