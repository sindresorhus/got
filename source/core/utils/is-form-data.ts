import is from '@sindresorhus/is';
import {Readable} from 'stream';

interface FormData extends Readable {
	getBoundary(): string;
}

export default (body: unknown): body is FormData => is.nodeStream(body) && is.function_((body as FormData).getBoundary);
