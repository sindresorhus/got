import {Readable} from 'node:stream';
import is from '@sindresorhus/is';

interface FormData extends Readable {
	getBoundary: () => string;
	getLength: (callback: (error: Error | null, length: number) => void) => void; // eslint-disable-line @typescript-eslint/ban-types
}

export default function isFormData(body: unknown): body is FormData {
	return is.nodeStream(body) && is.function_((body as FormData).getBoundary);
}
