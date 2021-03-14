import {ResponseType, ParseJsonFunction} from '../core/options';
import {ParseError} from './types';
import type {Response} from '../core/response';

const parseBody = (response: Response, responseType: ResponseType, parseJson: ParseJsonFunction, encoding?: BufferEncoding): unknown => {
	const {rawBody} = response;

	try {
		if (responseType === 'text') {
			return rawBody.toString(encoding);
		}

		if (responseType === 'json') {
			return rawBody.length === 0 ? '' : parseJson(rawBody.toString());
		}

		if (responseType === 'buffer') {
			return rawBody;
		}

		throw new ParseError({
			message: `Unknown body type '${responseType as string}'`,
			name: 'Error'
		}, response);
	} catch (error) {
		throw new ParseError(error, response);
	}
};

export default parseBody;
