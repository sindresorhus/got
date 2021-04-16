import {promisify} from 'util';
import {ClientRequestArgs} from 'http';
import is from '@sindresorhus/is';
import isFormData from './is-form-data.js';

export default async function getBodySize(body: unknown, headers: ClientRequestArgs['headers']): Promise<number | undefined> {
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

	return undefined;
}
