import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import type {ClientRequestArgs} from 'node:http';
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
		try {
			return await promisify(body.getLength.bind(body))();
		} catch (error: unknown) {
			const typedError = error as Error;
			throw new Error(
				'Cannot determine content-length for form-data with stream(s) of unknown length. '
				+ 'This is a limitation of the `form-data` package. '
				+ 'To fix this, either:\n'
				+ '1. Use the `knownLength` option when appending streams:\n'
				+ '   form.append(\'file\', stream, {knownLength: 12345});\n'
				+ '2. Switch to spec-compliant FormData (formdata-node package)\n'
				+ 'See: https://github.com/form-data/form-data#alternative-submission-methods\n'
				+ `Original error: ${typedError.message}`,
			);
		}
	}

	return undefined;
}
