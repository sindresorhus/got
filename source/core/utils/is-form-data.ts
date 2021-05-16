import {Readable} from 'stream';
import is from '@sindresorhus/is';

interface FormData extends Readable {
	getBoundary: () => string;
	getLength: (callback: (error: Error | null, length: number) => void) => void;
}

export default function isFormData(body: unknown): body is FormData {
	return is.nodeStream(body) && is.function_((body as FormData).getBoundary);
}
