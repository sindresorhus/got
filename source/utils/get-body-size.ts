import fs from 'fs';
import {promisify} from 'util';
import is from '@sindresorhus/is';
import isFormData from './is-form-data';

export default async (options: any): Promise<number | undefined> => {
	const {body} = options;

	if (options.headers['content-length']) {
		return Number(options.headers['content-length']);
	}

	if (!body && !options.stream) {
		return 0;
	}

	if (is.string(body)) {
		return Buffer.byteLength(body);
	}

	if (isFormData(body)) {
		return promisify(body.getLength.bind(body))();
	}

	if (body instanceof fs.ReadStream) {
		const {size} = await promisify(fs.stat)(body.path);
		return size;
	}

	return undefined;
};
