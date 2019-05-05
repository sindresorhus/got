import {ReadStream, stat} from 'fs';
import {promisify} from 'util';
import is from '@sindresorhus/is';
import isFormData from './is-form-data';
import {Options} from './types';

const statAsync = promisify(stat);

export default async (options: Options): Promise<number | undefined> => {
	const {body, headers, stream} = options;

	if (headers && 'content-length' in headers) {
		return Number(headers['content-length']);
	}

	if (!body && !stream) {
		return 0;
	}

	if (is.string(body)) {
		return Buffer.byteLength(body);
	}

	if (isFormData(body)) {
		// TS thinks this returns Promise<void> when it actually returns a number
		return promisify(body.getLength.bind(body))() as unknown as number;
	}

	if (body instanceof ReadStream) {
		const {size} = await statAsync(body.path);
		return size;
	}

	return undefined;
};
